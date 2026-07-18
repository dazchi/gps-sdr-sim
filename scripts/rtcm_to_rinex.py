import socket
import base64
import time
import math
from datetime import datetime, timedelta, timezone
from pyrtcm import RTCMReader

# --- Configuration ---
SERVER = "3.143.243.81"
PORT = 2101
MOUNTPOINT = "RTCM3EPH"
EMAIL = "your-mail@gmail.com"  # MUST BE YOUR ACTUAL EMAIL
OUTPUT_FILE = "live.n"
REQUIRED_SATS = 16  # Stop collecting once we have this many unique satellites

GPS_EPOCH = datetime(1980, 1, 6)

def format_rinex_float(val):
    """Formats a float to the strict 19-character RINEX scientific format"""
    if val is None:
        val = 0.0
    
    # Format to scientific notation with 12 decimal places
    # e.g., " 1.234567890123e-04" or "-1.234567890123e-04"
    s = f"{val:15.12e}"
    
    # Split into mantissa and exponent
    mantissa, exponent = s.split('e')
    
    # Rebuild in RINEX format: mantissa + 'D' + exponent (padded to 3 chars if needed)
    # Exponent comes out as '+05' or '-11', which is exactly what we want.
    formatted = f"{mantissa}D{exponent}"
    
    # Ensure it is EXACTLY 19 characters wide, right-justified.
    # If it's positive, this will pad a leading space.
    return f"{formatted:>19}"

def gps_week_to_utc(week, tow):
    """Converts GPS Week and Time of Week (TOE) to a UTC datetime"""
    return GPS_EPOCH + timedelta(weeks=week, seconds=tow)

def create_rinex_block(prn, df):
    """Maps pyrtcm DF fields perfectly to RINEX 2.11 variables"""
    
    # --- Time variables ---
    week_10bit = getattr(df, "DF076", 0)
    full_week = week_10bit + 2048  # Fix GPS Week Rollover
    
    toc = getattr(df, "DF081", 0.0) # Time of Clock
    dt = gps_week_to_utc(full_week, toc)
    
    # --- Clock biases ---
    af0 = getattr(df, "DF084", 0.0)
    af1 = getattr(df, "DF083", 0.0)
    af2 = getattr(df, "DF082", 0.0)
    
    # --- Line 2 variables ---
    iode = getattr(df, "DF071", 0.0)
    crs = getattr(df, "DF086", 0.0)
    # RTCM angles are in semi-circles. RINEX strictly requires radians (* pi)
    delta_n = getattr(df, "DF087", 0.0) * math.pi
    m0 = getattr(df, "DF088", 0.0) * math.pi
    
    # --- Line 3 variables ---
    cuc = getattr(df, "DF089", 0.0)
    e = getattr(df, "DF090", 0.0)
    cus = getattr(df, "DF091", 0.0)
    sqrta = getattr(df, "DF092", 0.0)
    
    # --- Line 4 variables ---
    toe = getattr(df, "DF093", 0.0)
    cic = getattr(df, "DF094", 0.0)
    omega0 = getattr(df, "DF095", 0.0) * math.pi
    cis = getattr(df, "DF096", 0.0)
    
    # --- Line 5 variables ---
    i0 = getattr(df, "DF097", 0.0) * math.pi
    crc = getattr(df, "DF098", 0.0)
    omega = getattr(df, "DF099", 0.0) * math.pi
    omega_dot = getattr(df, "DF100", 0.0) * math.pi
    
    # --- Line 6 variables ---
    idot = getattr(df, "DF079", 0.0) * math.pi
    codes_l2 = getattr(df, "DF078", 0.0)
    l2_p_flag = getattr(df, "DF103", 0.0)
    
    # --- Line 7 variables ---
    sv_acc = 2.0  # Safe default if URA index isn't explicitly mapped
    sv_health = getattr(df, "DF102", 0.0)
    tgd = getattr(df, "DF101", 0.0)
    iodc = getattr(df, "DF085", 0.0)
    
    # --- Line 8 variables ---
    transmission_time = 0.0
    fit_int = 4.0 if getattr(df, "DF137", 0) == 0 else 0.0

    # --- Formatting the Block ---
    yy = dt.year % 100
    line1 = (f"{prn:2d} {yy:2d} {dt.month:2d} {dt.day:2d} {dt.hour:2d} {dt.minute:2d} {dt.second:4.1f}"
             f"{format_rinex_float(af0)}"
             f"{format_rinex_float(af1)}"
             f"{format_rinex_float(af2)}")
    
    line2 = f"   {format_rinex_float(iode)}{format_rinex_float(crs)}{format_rinex_float(delta_n)}{format_rinex_float(m0)}"
    line3 = f"   {format_rinex_float(cuc)}{format_rinex_float(e)}{format_rinex_float(cus)}{format_rinex_float(sqrta)}"
    line4 = f"   {format_rinex_float(toe)}{format_rinex_float(cic)}{format_rinex_float(omega0)}{format_rinex_float(cis)}"
    line5 = f"   {format_rinex_float(i0)}{format_rinex_float(crc)}{format_rinex_float(omega)}{format_rinex_float(omega_dot)}"
    line6 = f"   {format_rinex_float(idot)}{format_rinex_float(codes_l2)}{format_rinex_float(full_week)}{format_rinex_float(l2_p_flag)}"
    line7 = f"   {format_rinex_float(sv_acc)}{format_rinex_float(sv_health)}{format_rinex_float(tgd)}{format_rinex_float(iodc)}"
    line8 = f"   {format_rinex_float(transmission_time)}{format_rinex_float(fit_int)}{format_rinex_float(0.0)}{format_rinex_float(0.0)}"

    return "\n".join([line1, line2, line3, line4, line5, line6, line7, line8]) + "\n"


def stream_to_rinex():
    print(f"[*] Connecting to {SERVER}:{PORT}...")
    
    # Dictionary to hold unique PRNs to prevent duplicates
    ephemeris_db = {}
    
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(15)
    
    try:
        s.connect((SERVER, PORT))
        auth_str = f"{EMAIL}:none"
        auth_b64 = base64.b64encode(auth_str.encode('ascii')).decode('ascii')
        
        request = (
            f"GET /{MOUNTPOINT} HTTP/1.0\r\n"
            f"User-Agent: NTRIP RTKLIB/2.4.3\r\n"
            f"Accept: */*\r\n"
            f"Connection: close\r\n"
            f"Authorization: Basic {auth_b64}\r\n"
            f"\r\n"
        )
        s.sendall(request.encode('ascii'))
        
        handshake = s.recv(1024)
        if b"200 OK" not in handshake:
            print("[-] Connection rejected.")
            print(handshake)
            return

        print("[+] Connected! Gathering GPS satellites (this takes ~1-3 minutes)...\n")
        
        reader = RTCMReader(s)
        
        for raw_data, parsed_data in reader:
            if parsed_data is not None and parsed_data.identity == "1019":
                prn = getattr(parsed_data, "DF009", 0)
                
                if prn not in ephemeris_db:
                    ephemeris_db[prn] = parsed_data
                    print(f"  -> Captured PRN {prn:02d} | Total unique: {len(ephemeris_db)}/{REQUIRED_SATS}")
                    
                    if len(ephemeris_db) >= REQUIRED_SATS:
                        print("\n[+] Target reached! Formatting RINEX file...")
                        break

        # Generate the RINEX 2.11 file
        with open(OUTPUT_FILE, "w") as f:
            now_str = datetime.now().strftime("%d-%b-%y %H:%M").upper()
            
            # 1. Write Header (Matching standard CDDIS layout)
            f.write("     2.11           NAVIGATION DATA                         RINEX VERSION / TYPE\n")
            f.write(f"pyrtcm              Python              {now_str}    PGM / RUN BY / DATE\n")
            f.write("    0.9313D-08  0.2235D-07 -0.5960D-07 -0.1192D-06          ION ALPHA           \n")
            f.write("    0.9830D+05  0.1475D+06 -0.6554D+05 -0.4588D+06          ION BETA            \n")
            f.write("   -0.931322574616D-09-0.355271367880D-14   233472     2427 DELTA-UTC: A0,A1,T,W\n")
            f.write("    18                                                      LEAP SECONDS        \n")
            f.write("                                                            END OF HEADER       \n")
            
            # 2. Write Data Blocks
            for prn, df in ephemeris_db.items():
                f.write(create_rinex_block(prn, df))
                
        print(f"[+] Success! {len(ephemeris_db)} satellites saved to {OUTPUT_FILE}.")

    except Exception as e:
        print(f"[-] Error: {e}")
    finally:
        s.close()

if __name__ == "__main__":
    stream_to_rinex()