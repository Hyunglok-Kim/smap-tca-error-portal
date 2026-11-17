#!/bin/zsh
# encode.sh FRAMES_DIR NAME OUT_DIR [CRF_H264] [CRF_VP9] [SCALE_W] — frames f_%04d.png -> NAME.mp4, NAME.webm, NAME.jpg (the first frame)
set -e
F="$1"; N="$2"; O="$3"; C1="${4:-26}"; C2="${5:-36}"; SW="${6:-960}"; R="${7:-24}"
mkdir -p "$O"
VF="scale=${SW}:-2:flags=lanczos"
ffmpeg -v error -y -framerate "$R" -i "$F/f_%04d.png" -vf "$VF" -c:v libx264 -preset slow -crf "$C1" -pix_fmt yuv420p -profile:v high -movflags +faststart -an "$O/$N.mp4"
ffmpeg -v error -y -framerate "$R" -i "$F/f_%04d.png" -vf "$VF" -c:v libvpx-vp9 -crf "$C2" -b:v 0 -row-mt 1 -deadline good -cpu-used 1 -pix_fmt yuv420p -an "$O/$N.webm"
ffmpeg -v error -y -i "$F/f_0000.png" -vf "$VF" -q:v 4 "$O/$N.jpg"
ls -l "$O/$N.mp4" "$O/$N.webm" "$O/$N.jpg" | awk '{printf "%s %.0f KB\n", $9, $5/1024}'
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,nb_frames,duration -of csv=p=0 "$O/$N.mp4"
