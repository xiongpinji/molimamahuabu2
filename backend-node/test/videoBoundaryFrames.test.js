const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const videoService = require('../src/services/videoService');

test('视频完成后提取首帧和尾帧并返回可访问地址', () => {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-video-frames-'));
  const localPath = path.join('videos', 'sample.mp4');
  const videoPath = path.join(storagePath, localPath);
  fs.mkdirSync(path.dirname(videoPath), { recursive: true });
  fs.writeFileSync(videoPath, 'video');

  const commands = [];
  const result = videoService.extractVideoBoundaryFrames(
    storagePath,
    localPath,
    42,
    { warn() {}, info() {} },
    {
      ffmpegPath: 'ffmpeg',
      hasFfmpeg: true,
      run(command, args) {
        commands.push({ command, args });
        fs.writeFileSync(args.at(-1), 'frame');
        return { status: 0, stderr: '' };
      },
    }
  );

  assert.equal(result.output_first_frame_url, '/static/videos/vg_42_first.jpg');
  assert.equal(result.output_last_frame_url, '/static/videos/vg_42_last.jpg');
  assert.equal(commands.length, 2);
  assert.ok(commands[0].args.includes('-frames:v'));
  assert.ok(commands[1].args.includes('-sseof'));
});

test('本地无 ffmpeg 时首尾帧提取保持可选且不影响视频完成', () => {
  const result = videoService.extractVideoBoundaryFrames(
    'C:\\storage',
    'videos\\sample.mp4',
    42,
    { warn() {}, info() {} },
    { hasFfmpeg: false }
  );

  assert.deepEqual(result, {
    output_first_frame_url: null,
    output_last_frame_url: null,
  });
});
