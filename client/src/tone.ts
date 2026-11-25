/**
 * Test-tone mode: exercise a call with no camera or microphone.
 *
 * The audio track is a 440 Hz sine from an OscillatorNode routed through
 * an AudioContext MediaStreamDestination. The video track is a 320x240
 * canvas painted once a second with a moving gradient and a timestamp,
 * captured with canvas.captureStream(). A peer on the other end hears the
 * tone and sees the moving frame, which proves media is flowing end to
 * end without any hardware.
 */

export function createTestToneStream(): MediaStream {
  const audioCtx = new AudioContext();
  const oscillator = audioCtx.createOscillator();
  oscillator.type = "sine";
  oscillator.frequency.value = 440;
  const gain = audioCtx.createGain();
  gain.gain.value = 0.2;
  const destination = audioCtx.createMediaStreamDestination();
  oscillator.connect(gain);
  gain.connect(destination);
  oscillator.start();

  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const paint = () => {
      const t = Date.now() / 1000;
      const gradient = ctx.createLinearGradient(0, 0, 320, 240);
      gradient.addColorStop(0, `hsl(${Math.floor((t * 40) % 360)}, 70%, 45%)`);
      gradient.addColorStop(1, `hsl(${Math.floor((t * 40 + 120) % 360)}, 70%, 30%)`);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 320, 240);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 20px sans-serif";
      ctx.fillText("voip-lab test tone", 20, 110);
      ctx.font = "16px sans-serif";
      ctx.fillText(new Date().toISOString(), 20, 140);
      ctx.fillText("no camera or mic needed", 20, 170);
    };
    paint();
    window.setInterval(paint, 1000);
  }
  const videoStream = canvas.captureStream(15);

  const stream = new MediaStream();
  for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
  for (const track of videoStream.getVideoTracks()) stream.addTrack(track);
  return stream;
}
