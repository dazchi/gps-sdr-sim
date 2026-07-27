# GPS-SDR-SIM

GPS-SDR-SIM generates GPS baseband signal data streams, which can be converted 
to RF using software-defined radio (SDR) platforms, such as 
[ADALM-Pluto](https://wiki.analog.com/university/tools/pluto), [bladeRF](http://nuand.com/), [HackRF](https://github.com/mossmann/hackrf/wiki), and [USRP](http://www.ettus.com/).

### Windows build instructions

1. Start Visual Studio.
2. Create an empty project for a console application.
3. On the Solution Explorer at right, add "gpssim.c" and "getopt.c" to the Souce Files folder.
4. Select "Release" in Solution Configurations drop-down list.
5. Build the solution.

### Building with GCC

```
$ gcc gpssim.c -lm -O3 -o gps-sdr-sim
```

### Using bigger user motion files

In order to use user motion files with more than 30000 samples (at 10Hz), the `USER_MOTION_SIZE`
variable can be set to the maximum time of the user motion file in seconds. It is advisable to do
this using make so gps-sdr-bin can update the size when needed. e.g:

```
$ make USER_MOTION_SIZE=4000
```

This variable can also be set when compiling directly with GCC:

```
$ gcc gpssim.c -lm -O3 -o gps-sdr-sim -DUSER_MOTION_SIZE=4000
```

### Generating the GPS signal file

A user-defined trajectory can be specified in either a CSV file, which contains 
the Earth-centered Earth-fixed (ECEF) user positions, or an NMEA GGA stream.
The sampling rate of the user motion has to be 10Hz.
The user is also able to assign a static location directly through the command line.

The user specifies the GPS satellite constellation through a GPS broadcast 
ephemeris file. The daily GPS broadcast ephemeris file (brdc) is a merge of the
individual site navigation files into one. The archive for the daily file can 
be downloaded from: https://cddis.nasa.gov/archive/gnss/data/daily/. Access 
to this site requires registration, which is free.

These files are then used to generate the simulated pseudorange and
Doppler for the GPS satellites in view. This simulated range data is 
then used to generate the digitized I/Q samples for the GPS signal.

The bladeRF and ADALM-Pluto command line interface requires I/Q pairs stored as signed 
16-bit integers, while the hackrf_transfer and gps-sdr-sim-uhd.py
support signed bytes.

HackRF, bladeRF and ADALM-Pluto can accept the default sample rate of 2.6MHz, 
while the USRP2 requires an even integral decimator of 100 MHz, i.e. 2.5MHz.

The simulation start time can be specified if the corresponding set of ephemerides
is available. Otherwise the first time of ephemeris in the RINEX navigation file
is selected.

The maximum simulation duration time is defined by USER_MOTION_SIZE to 
prevent the output file from getting too large.

The output file size can be reduced by using "-b 1" option to store 
four 1-bit I/Q samples into a single byte. 
You can use [bladeplayer](https://github.com/osqzss/gps-sdr-sim/tree/master/player)
for bladeRF to playback the compressed file.

```
Usage: gps-sdr-sim [options]
Options:
  -e <gps_nav>     RINEX navigation file for GPS ephemerides (required)
  -u <user_motion> User motion file in ECEF x, y, z format (dynamic mode)
  -x <user_motion> User motion file in lat, lon, height format (dynamic mode)
  -g <nmea_gga>    NMEA GGA stream (dynamic mode)
  -c <location>    ECEF X,Y,Z in meters (static mode) e.g. 3967283.15,1022538.18,4872414.48
  -l <location>    Lat,Lon,Hgt (static mode) e.g. 30.286502,120.032669,100
  -L <wnslf,dn,dtslf> User leap future event in GPS week number, day number, next leap second e.g. 2347,3,19
  -t <date,time>   Scenario start time YYYY/MM/DD,hh:mm:ss
  -T <date,time>   Overwrite TOC and TOE to scenario start time
  -d <duration>    Duration [sec] (dynamic mode max: 300 static mode max: 86400)
  -o <output>      I/Q sampling data file (default: gpssim.bin ; use - for stdout)
  -s <frequency>   Sampling frequency [Hz] (default: 2600000)
  -b <iq_bits>     I/Q data format [1/8/16] (default: 16)
  -i               Disable ionospheric delay for spacecraft scenario
  -p [fixed_gain]  Disable path loss and hold power level constant
  -v               Show details about simulated channels
  -H               Transmit directly via HackRF (must use with -b 8, bypasses output file)
  -S               Accept live LLH positions via TCP socket (port 6000, requires -H -b 8)
                   Format: lat,lon,height\n  Consecutive jumps > 10000 m are rejected
                   Echoes back each processed position as lat,lon,height\n for UI feedback
```

The user motion can be specified in either dynamic or static mode:

```
> gps-sdr-sim -e brdc3540.14n -u circle.csv
```

```
> gps-sdr-sim -e brdc3540.14n -x circle_llh.csv
```

```
> gps-sdr-sim -e brdc3540.14n -g triumphv3.txt
```

```
> gps-sdr-sim -e brdc3540.14n -l 30.286502,120.032669,100
```

### Transmitting the samples

The TX port of a particular SDR platform is connected to the GPS receiver 
under test through a DC block and a fixed 50-60dB attenuator.

#### BladeRF:

The simulated GPS signal file, named "gpssim.bin", can be loaded
into the bladeRF for playback as shown below:

```
set frequency 1575.42M
set samplerate 2.6M
set bandwidth 2.5M
set txvga1 -25
cal lms
cal dc tx
tx config file=gpssim.bin format=bin
tx start
```

You can also execute these commands via the `bladeRF-cli` script option as below:
```
> bladeRF-cli -s bladerf.script
```

#### HackRF:

**Option 1 — Direct transmit (no intermediate file):**

Use the `-H` flag to stream I/Q samples directly to a connected HackRF device in real time via a ring buffer. This requires 8-bit signed I/Q format (`-b 8`).

```
> gps-sdr-sim -e brdc0010.22n -b 8 -H
```

**Option 2 — File-based transmit:**

Generate a file first, then play it back with `hackrf_transfer`:

```
> gps-sdr-sim -e brdc0010.22n -b 8
> hackrf_transfer -t gpssim.bin -f 1575420000 -s 2600000 -a 1 -x 0
```

#### UHD supported devices (tested with USRP2 only):

```
> gps-sdr-sim-uhd.py -t gpssim.bin -s 2500000 -x 0
```

You can also use `tx_samples_from_file` tool included in the UHD examples:
```
> tx_samples_from_file --file gpssim.bin --type short --rate 2500000 --freq 1575420000 --gain 0
```

#### LimeSDR (in case of 1 Msps 1-bit file, to get full BaseBand dynamic and low RF power):

```
> limeplayer -s 1000000 -b 1 -d 2047 -g 0.1 < ../circle.1b.1M.bin
```

#### ADALM-Pluto (PlutoSDR):

The ADALM-Pluto device is expected to have its network interface up and running and is accessible
via "pluto.local" by default.

Default settings:
```
> plutoplayer -t gpssim.bin
```
Set TX attenuation:
```
> plutoplayer -t gpssim.bin -a -30.0
```
Default -20.0dB. Applicable range 0.0dB to -80.0dB in 0.25dB steps.

Set RF bandwidth:
```
> plutoplayer -t gpssim.bin -b 3.0
```
Default 3.0MHz. Applicable range 1.0MHz to 5.0MHz.

### Live position streaming (`-S`)

The `-S` flag enables real-time GPS position injection over a TCP socket on port **6000**. This is intended for use alongside `-H -b 8` for continuous HackRF transmission.

**Protocol:**
- Send positions as newline-terminated CSV: `lat,lon,height\n` (decimal degrees, metres)
- gps-sdr-sim echoes back each processed position in the same format for UI feedback
- Consecutive position jumps greater than 10 000 m are silently rejected

**Example — static position via netcat:**
```
gps-sdr-sim -e live.n -b 8 -H -S
echo "1.3521,103.8198,30.0" | nc 127.0.0.1 6000
```

### Live ephemeris capture (`scripts/rtcm_to_rinex.py`)

`scripts/rtcm_to_rinex.py` connects to a public NTRIP caster, captures RTCM 1019 messages for up to 16 GPS satellites, and writes a RINEX 2.11 navigation file (`live.n`) for use with `-T now`:

```
python scripts/rtcm_to_rinex.py   # requires pyrtcm (pip install pyrtcm)
gps-sdr-sim -e scripts/live.n -b 8 -H -S -T now
```

The script targets the `RTCM3EPH` mountpoint by default. Edit the `SERVER`, `PORT`, and `EMAIL` constants at the top of the file to use a different NTRIP caster.

### Web route planner (`frontend/`)

A browser-based route planner that streams GPS positions to a running `gps-sdr-sim -H -b 8 -S` instance.

**Features:**
- Interactive Leaflet map — click to add waypoints, right-click to teleport the sim position
- Manual waypoint entry with paste support for Google-Maps-style `lat, lng` strings
- Auto-locate on page load (OSM-style blue-dot marker with accuracy circle)
- Route planning via [GraphHopper](https://www.graphhopper.com/) (foot / bike / car profiles) or raw waypoint interpolation; long routes are split across multiple requests to respect the per-request waypoint limit
- Walk / Bike / Drive speed presets (5 / 10 / 40 km/h)
- Repeat modes: **Off** (stop at end), **Bounce** (back-and-forth), or **Loop** (route last back to first), each with a configurable loop count (blank = infinite)
- Speed jitter and random stops — at waypoints only, at every route track point (optional), and at start/end for Bounce/Loop modes
- Toggle to render every route track point as a bright yellow dot on the map
- Track-point count and estimated total distance × loop count shown in the info panel
- Sim LLH feedback: displays the last position processed by gps-sdr-sim; click to pan the map
- GPX export of the planned route
- SRTM elevation lookup via [OpenTopoData](https://www.opentopodata.org/)

**Setup:**
```
cd frontend
npm install
# Optional: create keys.js with your GraphHopper API key for route planning
echo "module.exports = { graphhopper: 'YOUR_KEY_HERE' };" > keys.js
node server.js
```

Open `http://localhost:3000` in a browser, start `gps-sdr-sim` with `-H -b 8 -S`, then click **Connect to Simulator**.

The Node.js server bridges the browser WebSocket connection to gps-sdr-sim's TCP socket on port 6000 and proxies routing and elevation API requests server-side to avoid CORS restrictions.

### License

Copyright &copy; 2015-2025 Takuji Ebinuma  
Distributed under the [MIT License](http://www.opensource.org/licenses/mit-license.php).
