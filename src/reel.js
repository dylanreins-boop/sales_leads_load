// Makes a vertical Reel / Short / TikTok video (1080x1920, 30 fps) from a post's photos and clips with
// ffmpeg: each photo fills the frame over a blurred copy of itself and slowly zooms in, clips play up to
// 5 seconds, BEFORE / AFTER labels, a wipe from the before to the after, the opening line on the first
// shot, and an end card with the logo, the closing words and the phone number. Music if the shop uploaded
// a track (silent otherwise). An AI-made intro, when there is one, goes first with "AI-generated" on it.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const W = 1080;
const H = 1920;
const FADE = 0.45; // seconds each transition overlaps
const PHOTO_S = 2.6;
const CLIP_MAX_S = 5;
const INTRO_MAX_S = 6;
const END_S = 2.8;
const NAVY = '0x0b1626';
const FONTS = [
  process.env.SOCIAL_FONT,
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
].filter(Boolean);
const findFont = () => FONTS.find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } }) || null;

function run(args, { timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    let err = '';
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('Making the video took too long.')); }, timeoutMs);
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(t); reject(new Error(e.code === 'ENOENT' ? 'The server has no video maker (ffmpeg) installed.' : e.message)); });
    p.on('close', (code) => { clearTimeout(t); if (code === 0) resolve(); else reject(new Error(`ffmpeg failed: ${err.trim().split('\n').pop() || code}`)); });
  });
}

// How long a clip is, in seconds (0 if it can't tell).
function duration(file) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 20000 }, (err, out) => {
      resolve(err ? 0 : Number(String(out).trim()) || 0);
    });
  });
}

// drawtext doesn't wrap: break the words into lines of about `width` characters.
function wrap(text, width) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (line && (line + ' ' + word).length > width) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.slice(0, 4).join('\n');
}

/**
 * segments: [{ kind: 'photo' | 'clip', path, label: 'BEFORE' | 'AFTER' | null }]
 * opts: { out, workDir, intro (path to an AI clip), hook, endText, phone, brandName, logo, music, text (false: no words) }
 */
async function makeReel(segments, opts) {
  const { out, workDir, intro = null, hook = '', endText = '', phone = '', brandName = '', logo = null, music = null } = opts;
  if (!segments.length) throw new Error('Pick at least one photo or clip.');
  fs.mkdirSync(workDir, { recursive: true });
  const font = opts.text === false ? null : findFont();
  const useText = opts.text !== false;
  // Words go in small text files, so nothing in them needs escaping.
  let n = 0;
  const textFile = (s) => { const f = path.join(workDir, `t${n += 1}.txt`); fs.writeFileSync(f, s); return f; };
  const fontArg = font ? `fontfile=${font}` : 'font=Sans';
  const draw = (file, more, color = 'white') => `drawtext=${fontArg}:textfile=${file}:fontcolor=${color}:${more}`;

  const shots = [];
  if (intro) shots.push({ kind: 'clip', path: intro, label: null, ai: true });
  shots.push(...segments);

  const args = [];
  const filters = [];
  const durations = [];
  let input = 0;
  for (const [i, s] of shots.entries()) {
    let d;
    if (s.kind === 'photo') {
      d = s.label === 'AFTER' ? PHOTO_S + 0.3 : PHOTO_S;
      args.push('-loop', '1', '-framerate', '30', '-t', String(d), '-i', s.path);
    } else {
      const real = await duration(s.path);
      d = Math.max(1.5, Math.min(real || CLIP_MAX_S, s.ai ? INTRO_MAX_S : CLIP_MAX_S));
      args.push('-t', String(d), '-i', s.path);
    }
    durations.push(d);
    const v = `[${input}:v]`;
    input += 1;
    // Fill the frame: a blurred, darkened copy behind, the whole picture on top.
    let chain = `${v}fps=30,split[a${i}][b${i}];[a${i}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=28:2,eq=brightness=-0.14[bg${i}];`
      + `[b${i}]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg${i}];[bg${i}][fg${i}]overlay=(W-w)/2:(H-h)/2,setsar=1`;
    if (s.kind === 'photo') chain += `,zoompan=z='min(1+0.0011*on,1.1)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=30`;
    chain += `,trim=duration=${d},setpts=PTS-STARTPTS`;
    if (useText && s.label) chain += `,${draw(textFile(s.label), `fontsize=50:box=1:boxcolor=black@0.55:boxborderw=22:x=64:y=170`)}`;
    if (useText && s.ai) chain += `,${draw(textFile('AI-generated'), `fontsize=34:box=1:boxcolor=black@0.5:boxborderw=14:x=(w-text_w)/2:y=h-230`)}`;
    if (useText && i === 0 && hook) {
      chain += `,${draw(textFile(wrap(hook, 18)), `fontsize=84:line_spacing=14:box=1:boxcolor=black@0.45:boxborderw=28:x=(w-text_w)/2:y=h*0.17:shadowcolor=black@0.6:shadowx=3:shadowy=3`)}`;
    }
    filters.push(`${chain},format=yuv420p[v${i}]`);
  }

  // The end card: logo (or the company name), the closing words and the phone number.
  const endIdx = shots.length;
  args.push('-f', 'lavfi', '-t', String(END_S), '-i', `color=c=${NAVY}:s=${W}x${H}:r=30`);
  const endInput = input;
  input += 1;
  let end = `[${endInput}:v]setsar=1`;
  let logoIn = null;
  if (logo && fs.existsSync(logo)) {
    args.push('-loop', '1', '-framerate', '30', '-t', String(END_S), '-i', logo);
    logoIn = input;
    input += 1;
  }
  if (logoIn != null) {
    filters.push(`[${logoIn}:v]scale=640:-1,format=rgba[logo]`);
    end = `[${endInput}:v][logo]overlay=(W-w)/2:560:shortest=1,setsar=1`;
  }
  if (useText) {
    if (logoIn == null && brandName) end += `,${draw(textFile(wrap(brandName, 20)), 'fontsize=76:x=(w-text_w)/2:y=640')}`;
    if (endText) end += `,${draw(textFile(wrap(endText, 22)), 'fontsize=64:x=(w-text_w)/2:y=1080')}`;
    if (phone) end += `,${draw(textFile(phone), 'fontsize=60:x=(w-text_w)/2:y=1220', '0xf2b134')}`;
  }
  filters.push(`${end},trim=duration=${END_S},setpts=PTS-STARTPTS,format=yuv420p[v${endIdx}]`);
  durations.push(END_S);

  // Join them: a wipe from the last before to the first after, a fade into the end card, slides between the rest.
  const all = [...shots, { end: true }];
  let last = 'v0';
  let offset = 0;
  for (let i = 1; i < all.length; i += 1) {
    offset += durations[i - 1] - FADE;
    const kind = all[i].end ? 'fade' : all[i - 1].label === 'BEFORE' && all[i].label === 'AFTER' ? 'wipeleft' : all[i - 1].ai ? 'fadeblack' : 'slideleft';
    const name = i === all.length - 1 ? 'vout' : `x${i}`;
    filters.push(`[${last}][v${i}]xfade=transition=${kind}:duration=${FADE}:offset=${offset.toFixed(3)}[${name}]`);
    last = name;
  }
  if (all.length === 1) filters.push('[v0]null[vout]');
  const total = durations.reduce((t, d) => t + d, 0) - FADE * (all.length - 1);

  if (music && fs.existsSync(music)) args.push('-stream_loop', '-1', '-i', music);
  else args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');
  const audioIn = input;
  filters.push(`[${audioIn}:a]atrim=0:${total.toFixed(3)},afade=t=out:st=${Math.max(0, total - 1.2).toFixed(3)}:d=1.2,asetpts=PTS-STARTPTS[aout]`);

  await run([...args, '-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '128k', '-t', total.toFixed(3), '-movflags', '+faststart', out]);
  return { seconds: Math.round(total * 10) / 10 };
}

// Words on the video need a font; if the server's ffmpeg can't draw text, make it without words.
async function makeReelSafely(segments, opts) {
  try {
    return await makeReel(segments, opts);
  } catch (err) {
    if (opts.text === false || !/drawtext|font|Fontconfig/i.test(err.message)) throw err;
    return { ...(await makeReel(segments, { ...opts, text: false })), note: 'Made without the words on screen (the server\'s video maker can\'t draw text).' };
  }
}

module.exports = { makeReel: makeReelSafely, wrap, findFont };
