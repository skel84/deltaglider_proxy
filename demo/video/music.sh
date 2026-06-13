#!/usr/bin/env bash
# Generate an ORIGINAL, license-clean ambient music bed and mix it under the
# demo video. No external audio — every tone is synthesized with ffmpeg, so
# there are zero copyright concerns for a public/YouTube upload.
#
# The bed is a slow four-chord pad loop (warm, tech-optimistic), softened with
# low-pass + echo + gentle tremolo, faded in/out, sitting quietly under the
# (silent) screen capture.
#
# Usage: demo/video/music.sh [input.mp4] [output.mp4]
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
IN="${1:-$ROOT/deltaglider-demo-90s.mp4}"
OUT="${2:-$ROOT/deltaglider-demo-90s-music.mp4}"
WORK="${DGP_DEMO_DIR:-/private/tmp/dgp-demo-video}/music"; rm -rf "$WORK"; mkdir -p "$WORK"

DUR=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$IN")
BAR=4.0          # seconds per chord
SR=44100

# Chord progression (Hz). A gentle Cmaj9-ish loop in a warm register:
#   Fmaj7  →  Cmaj7  →  Gmaj  →  Am7   (I–V–vi flavour, resolves softly, loops)
# Each chord = root + third + fifth + an upper voice, as layered sines.
CHORDS=(
  "174.61 220.00 261.63 349.23"   # F  A  C  F   (Fmaj)
  "130.81 196.00 261.63 329.63"   # C  G  C  E   (Cmaj)
  "196.00 246.94 293.66 392.00"   # G  B  D  G   (Gmaj)
  "220.00 261.63 329.63 440.00"   # A  C  E  A   (Am)
)

echo "==> synth chord pads (bar=${BAR}s)"
build_chord() {  # $1=index  $2="f1 f2 f3 f4"
  local idx="$1"; shift
  read -r f1 f2 f3 f4 <<< "$*"
  # Four detuned sine voices summed; soft attack/release per bar so chords breathe.
  ffmpeg -y \
    -f lavfi -i "sine=frequency=$f1:sample_rate=$SR:duration=$BAR" \
    -f lavfi -i "sine=frequency=$f2:sample_rate=$SR:duration=$BAR" \
    -f lavfi -i "sine=frequency=$f3:sample_rate=$SR:duration=$BAR" \
    -f lavfi -i "sine=frequency=$f4:sample_rate=$SR:duration=$BAR" \
    -filter_complex "[0]volume=0.30[a];[1]volume=0.24[b];[2]volume=0.20[c];[3]volume=0.12[d];\
[a][b][c][d]amix=inputs=4:normalize=0,afade=t=in:st=0:d=1.2,afade=t=out:st=$(echo "$BAR-1.2"|bc):d=1.2[out]" \
    -map "[out]" -ac 2 "$WORK/chord$idx.wav" >/dev/null 2>&1
}
for i in "${!CHORDS[@]}"; do build_chord "$i" "${CHORDS[$i]}"; done

echo "==> loop progression to cover ${DUR}s"
# Concat the 4 chords once, then loop the 16s block enough times to exceed DUR.
printf "file 'chord0.wav'\nfile 'chord1.wav'\nfile 'chord2.wav'\nfile 'chord3.wav'\n" > "$WORK/prog.txt"
ffmpeg -y -f concat -safe 0 -i "$WORK/prog.txt" -c copy "$WORK/prog.wav" >/dev/null 2>&1
LOOP_SEC=$(echo "$BAR*4"|bc)
REPS=$(python3 -c "import math;print(math.ceil($DUR/$LOOP_SEC)+1)")
: > "$WORK/full.txt"; for _ in $(seq 1 "$REPS"); do echo "file 'prog.wav'" >> "$WORK/full.txt"; done
ffmpeg -y -f concat -safe 0 -i "$WORK/full.txt" -c copy "$WORK/loop.wav" >/dev/null 2>&1

echo "==> shape the bed (warmth + space) and trim to length"
# Low-pass for warmth, gentle echo for space, slow tremolo for movement,
# trim to video length with a long fade out. Kept quiet (-18 LUFS-ish).
# volume=6.0 + a soft limiter lands the bed at ~ -24 dB mean / -12 dB peak —
# present on phone speakers, never fighting the visuals.
ffmpeg -y -i "$WORK/loop.wav" -t "$DUR" \
  -af "lowpass=f=1900,aecho=0.8:0.7:90:0.25,tremolo=f=0.12:d=0.18,volume=6.0,alimiter=limit=0.5:level=false,\
afade=t=in:st=0:d=2.5,afade=t=out:st=$(echo "$DUR-3.5"|bc):d=3.5" \
  "$WORK/bed.wav" >/dev/null 2>&1

echo "==> mux bed under video"
ffmpeg -y -i "$IN" -i "$WORK/bed.wav" \
  -map 0:v -map 1:a -c:v copy -c:a aac -b:a 160k -shortest "$OUT" >/dev/null 2>&1

DURO=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$OUT")
echo "done: $OUT  (${DURO}s, with ambient music bed)"
