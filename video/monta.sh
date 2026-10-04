#!/usr/bin/env bash
# Joins the recorded scenes into the demo video: the opening title over
# scene 1, the closing title over the public site at the end of scene 6, a
# short fade at each cut, no audio. H.264, 30 fps, 1920x1080.
#
# Run after: pnpm tsx video/registra.ts tutto   (or the scenes one by one, then "titoli")
# Output:    video/out/sigillo-demo.mp4, sigillo-demo.srt, sigillo-demo-sottotitolato.mp4 (subtitles burned in);
#            with SIGILLO_VIDEO_LANG=en: sigillo-demo-en.mp4, sigillo-demo-en.srt, sigillo-demo-en-subtitled.mp4
set -euo pipefail

# SIGILLO_VIDEO_LANG=en joins the English recording (scene-en/, *-en.*) instead of the Italian one.
LANG_CODE="${SIGILLO_VIDEO_LANG:-it}"
SUFFIX=""
[ "$LANG_CODE" = "en" ] && SUFFIX="-en"
SUB_NAME="sottotitolato"
[ "$LANG_CODE" = "en" ] && SUB_NAME="subtitled"
OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/out"
S="$OUT/scene$SUFFIX"
for n in 1 2 3 4 5 6; do
  [ -f "$S/scena-$n.mp4" ] || { echo "missing $S/scena-$n.mp4: record it with registra.ts" >&2; exit 1; }
done
[ -f "$S/titolo-apertura.png" ] || { echo "missing title cards: pnpm tsx video/registra.ts titoli" >&2; exit 1; }

duration() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"; }
D6=$(duration "$S/scena-6.mp4")
# The closing title comes in over the public site, a few seconds after it appears (it is the last 10 s of scene 6).
CLOSE_FROM=$(awk -v d="$D6" 'BEGIN { printf "%.2f", d - 7 }')

FADE=0.3
fades() { # $1 = scene duration: fade in at the start, fade out at the end
  awk -v d="$1" -v f="$FADE" 'BEGIN { printf "fade=t=in:st=0:d=%s,fade=t=out:st=%.3f:d=%s", f, d - f, f }'
}

ffmpeg -y -loglevel error \
  -i "$S/scena-1.mp4" -i "$S/scena-2.mp4" -i "$S/scena-3.mp4" \
  -i "$S/scena-4.mp4" -i "$S/scena-5.mp4" -i "$S/scena-6.mp4" \
  -loop 1 -i "$S/titolo-apertura.png" -loop 1 -i "$S/titolo-chiusura.png" \
  -filter_complex "
    [6:v]format=rgba,fade=t=in:st=0.6:d=0.8:alpha=1,fade=t=out:st=6.4:d=0.8:alpha=1[t1];
    [7:v]format=rgba,fade=t=in:st=${CLOSE_FROM}:d=0.8:alpha=1[t6];
    [0:v][t1]overlay=shortest=1,$(fades "$(duration "$S/scena-1.mp4")")[v1];
    [1:v]$(fades "$(duration "$S/scena-2.mp4")")[v2];
    [2:v]$(fades "$(duration "$S/scena-3.mp4")")[v3];
    [3:v]$(fades "$(duration "$S/scena-4.mp4")")[v4];
    [4:v]$(fades "$(duration "$S/scena-5.mp4")")[v5];
    [5:v][t6]overlay=shortest=1,$(fades "$D6")[v6];
    [v1][v2][v3][v4][v5][v6]concat=n=6:v=1:a=0,fps=30,format=yuv420p[v]" \
  -map "[v]" -c:v libx264 -preset slow -crf 17 -r 30 -movflags +faststart \
  "$OUT/sigillo-demo$SUFFIX.mp4"

echo "wrote $OUT/sigillo-demo$SUFFIX.mp4 ($(duration "$OUT/sigillo-demo$SUFFIX.mp4") s)"

# The subtitles, timed on these very scenes.
cd "$OUT/../.." && pnpm exec tsx video/registra.ts sottotitoli

# The same film with the subtitles burned in, for players that do not load an .srt.
ffmpeg -y -loglevel error -i "$OUT/sigillo-demo$SUFFIX.mp4" \
  -vf "subtitles=$OUT/sigillo-demo$SUFFIX.srt:charenc=UTF-8:force_style='FontName=DejaVu Sans,FontSize=13,PrimaryColour=&H00FFFFFF,BackColour=&H99000000,BorderStyle=4,Outline=0,Shadow=0,MarginV=22,Alignment=2'" \
  -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p -movflags +faststart "$OUT/sigillo-demo$SUFFIX-$SUB_NAME.mp4"
echo "wrote $OUT/sigillo-demo$SUFFIX-$SUB_NAME.mp4"
