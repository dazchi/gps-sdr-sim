import os
import xml.etree.ElementTree as ET
import numpy as np
import pandas as pd
import argparse


def haversine_distance(lat1, lon1, lat2, lon2):
    """Calculate the great-circle distance between two points on Earth in meters."""
    R = 6371000  # Radius of Earth in meters
    phi1, phi2 = np.radians(lat1), np.radians(lat2)
    dphi = np.radians(lat2 - lat1)
    dlambda = np.radians(lon2 - lon1)

    a = (
        np.sin(dphi / 2) ** 2
        + np.cos(phi1) * np.cos(phi2) * np.sin(dlambda / 2) ** 2
    )
    return R * 2 * np.arctan2(np.sqrt(a), np.sqrt(1 - a))


def gpx_to_split_csv(
    gpx_path,
    total_duration_min=10,
    max_file_seconds=300.0,
    reverse_direction=False,
    initial_delay_seconds=0.0,
    stop_probability=0.2,            
    stop_duration_range=(5.0, 15.0), 
    speed_jitter=0.1                 
):
    """Parses a GPX file, adds an optional initial stationary delay, applies 
    speed jitter and random waypoint stops, interpolates the track uniformly 
    at 0.1s increments, and splits the data into CSV files.
    """
    if not os.path.exists(gpx_path):
        print(f"Error: File '{gpx_path}' not found.")
        return

    # 1. Parse GPX File
    print(f"Parsing '{gpx_path}'...")
    tree = ET.parse(gpx_path)
    root = tree.getroot()

    # Define standard GPX namespace map
    ns = {"gpx": "http://www.topografix.com/GPX/1/1"}

    pts = []
    for trkpt in root.findall(".//gpx:trkpt", ns):
        lat = float(trkpt.attrib["lat"])
        lon = float(trkpt.attrib["lon"])

        # Safely extract elevation, defaulting to 0.0 if not present
        ele_node = trkpt.find("gpx:ele", ns)
        ele = float(ele_node.text) if ele_node is not None else 0.0

        pts.append((lat, lon, ele))

    if len(pts) < 2:
        print("Error: The GPX file must contain at least 2 trackpoints.")
        return

    # --- REVERSE DIRECTION OPTION ---
    if reverse_direction:
        print("Option enabled: Reversing path direction (End point -> Start point)...")
        pts = pts[::-1]

    # Get the starting coordinates (used for the initial fixed delay)
    start_lat, start_lon, start_ele = pts[0]

    # 2. Compute Cumulative Distance along the track
    distances = [0.0]
    for i in range(1, len(pts)):
        d = haversine_distance(
            pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]
        )
        distances.append(distances[-1] + d)

    total_distance = distances[-1]
    
    if total_distance == 0:
        print("Error: Total route distance is 0.")
        return

    # 3. Create Jittered Time-Distance Profile
    base_moving_seconds = total_duration_min * 60.0
    base_speed = total_distance / base_moving_seconds  # meters per second
    
    # Cap speed jitter to ensure we never get a negative or zero time segment
    speed_jitter = max(0.0, min(0.99, speed_jitter))
    
    profile_times = [0.0]
    profile_distances = [0.0]
    current_time = 0.0

    print("Generating route dynamics (applying speed jitter and random stops)...")
    for i in range(1, len(pts)):
        segment_dist = distances[i] - distances[i - 1]
        
        if segment_dist > 0:
            # Jitter the speed for this segment
            jitter_factor = np.random.uniform(1.0 - speed_jitter, 1.0 + speed_jitter)
            seg_time = (segment_dist / base_speed) * jitter_factor
            
            current_time += seg_time
            profile_times.append(current_time)
            profile_distances.append(distances[i])
            
            # Random Stop Logic (Exclude stopping at the very last destination point)
            if i < len(pts) - 1 and np.random.rand() < stop_probability:
                stop_duration = np.random.uniform(stop_duration_range[0], stop_duration_range[1])
                current_time += stop_duration
                
                # Hold the distance constant while time advances
                profile_times.append(current_time)
                profile_distances.append(distances[i])

    total_route_seconds = current_time

    # 4. Create High-Resolution Moving Timeline (0.1s steps)
    route_time = np.arange(0.0, total_route_seconds + 0.1, 0.1)

    # Interpolate time into a distance target array based on the dynamic profile
    target_distance = np.interp(route_time, profile_times, profile_distances)

    # Perform Linear Interpolation to map distances back to lat/lon/ele coordinates
    lats, lons, eles = (
        [p[0] for p in pts],
        [p[1] for p in pts],
        [p[2] for p in pts],
    )

    route_df = pd.DataFrame(
        {
            "relative time in seconds": route_time,
            "Latitude": np.interp(target_distance, distances, lats).round(9),
            "Longitude": np.interp(target_distance, distances, lons).round(9),
            "height": np.interp(target_distance, distances, eles).round(3),
        }
    )

    # --- INITIAL STATIONARY DELAY COUPLING ---
    if initial_delay_seconds > 0:
        print(f"Adding initial stationary delay of {initial_delay_seconds} seconds...")
        # Create timeline for the delay period (excluding the very last point to prevent duplication)
        delay_time = np.arange(0.0, initial_delay_seconds, 0.1)
        
        delay_df = pd.DataFrame(
            {
                "relative time in seconds": delay_time,
                "Latitude": round(start_lat, 9),
                "Longitude": round(start_lon, 9),
                "height": round(start_ele, 3),
            }
        )
        
        # Shift the route timeline forward to sit immediately after the delay
        route_df["relative time in seconds"] += initial_delay_seconds
        
        # Combine the fixed position data with the moving data
        interp_df = pd.concat([delay_df, route_df], ignore_index=True)
    else:
        interp_df = route_df

    # Standardize precision and force time rounding
    interp_df["relative time in seconds"] = interp_df["relative time in seconds"].round(1)

    # 5. Chunk Data into Hard-Limited Files (Max 300.0s per file)
    base_name = os.path.splitext(gpx_path)[0]
    suffix = "_reversed" if reverse_direction else ""
    rows_per_chunk = int(max_file_seconds * 10) + 1  # 3001 rows for 0.0-300.0s

    start_idx = 0
    file_index = 1

    print("\nGenerating split CSV outputs:")
    while start_idx < len(interp_df):
        # Slice up to the 300.0s boundary mark
        end_idx = start_idx + rows_per_chunk
        chunk_df = interp_df.iloc[start_idx:end_idx].copy()

        # Reset time relative to the beginning of this specific file chunk
        base_time = chunk_df["relative time in seconds"].iloc[0]
        chunk_df["relative time in seconds"] = (
            chunk_df["relative time in seconds"] - base_time
        ).round(1)

        # Export to CSV
        output_filename = f"{base_name}{suffix}_part{file_index}.csv"
        chunk_df.to_csv(output_filename, index=False)

        max_time = chunk_df["relative time in seconds"].max()
        print(
            f" -> {output_filename} | Rows: {len(chunk_df)} | Timeline: 0.0s to {max_time}s"
        )

        # Advance start index (ensures no duplicate overlap point at boundaries)
        start_idx = end_idx
        file_index += 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Convert GPX to high-resolution split CSVs with speed jitter and random stops.")
    
    # Required positional argument
    parser.add_argument("gpx_file", type=str, help="Path to the input GPX file")
    
    # Optional parameters with defaults matching previous configuration
    parser.add_argument("--duration", type=float, default=30.0, 
                        help="Base duration spent moving in minutes (default: 30.0)")
    parser.add_argument("--max-file-seconds", type=float, default=3000.0, 
                        help="Hard limit for each split file in seconds (default: 3000.0)")
    parser.add_argument("--reverse", action="store_true", 
                        help="Include this flag to reverse the path direction")
    parser.add_argument("--initial-delay", type=float, default=60.0, 
                        help="Time in seconds to stay perfectly still at start (default: 60.0)")
    parser.add_argument("--stop-prob", type=float, default=0.15, 
                        help="Probability (0.0 to 1.0) to stop at any given waypoint (default: 0.15)")
    parser.add_argument("--stop-min", type=float, default=3.0, 
                        help="Minimum wait time in seconds when a stop occurs (default: 3.0)")
    parser.add_argument("--stop-max", type=float, default=12.0, 
                        help="Maximum wait time in seconds when a stop occurs (default: 12.0)")
    parser.add_argument("--speed-jitter", type=float, default=0.20, 
                        help="Randomly modulate speed by +/- this fraction (default: 0.20)")

    args = parser.parse_args()

    gpx_to_split_csv(
        gpx_path=args.gpx_file,
        total_duration_min=args.duration,
        max_file_seconds=args.max_file_seconds,
        reverse_direction=args.reverse,
        initial_delay_seconds=args.initial_delay,
        stop_probability=args.stop_prob,
        stop_duration_range=(args.stop_min, args.stop_max),
        speed_jitter=args.speed_jitter
    )