// client/src/console/FaceCapture.tsx — milestone 26, the camera half of project/KYC.dc.html.
//
// THE BOARD'S CAMERA IS A SIMULATION — a drawn face, a timer, a prompt — and what is built here is the real thing with the
// same screens: getUserMedia, the front camera, five seconds recorded by MediaRecorder, the board's prompts on the board's
// schedule, and the "face found / face lost" states driven by the browser's own FaceDetector where it has one.
//
// WHERE THERE IS NO FaceDetector (Firefox, Safari today) THE RECORDING IS STARTED BY A BUTTON instead of by itself. The
// board's "starts automatically when we see your face" needs something that sees faces; without one, claiming it would mean
// recording whatever the camera is pointed at after a timer. A merchant who taps "Start recording" with their face in the
// oval gets the same five seconds.
//
// WHAT THIS DOES NOT DO is decide the video is a live person who matches the ID. Nothing in the browser can — and a client
// that said so would be vouching for itself. The prompts (turn left, turn right, blink) exist so the REVIEWER can see a
// live head moving; the judgement is theirs (milestone 27).
//
// THE VIEW IS A SEPARATE COMPONENT FROM THE LOGIC so the render gate can draw every phase without a camera, the way the
// other screens take `initial…` props.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '../shared/ui/index.ts';
import { TIPS, VIDEO_SECONDS, pickVideoType, promptAt } from './kycLines.ts';

export type FacePhase = 'tips' | 'blocked' | 'starting' | 'searching' | 'ready' | 'detected' | 'recording' | 'lost' | 'saving';

export function TipsView({ onReady }: { onReady: () => void }): ReactNode {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="m-0 font-display text-[26px] leading-tight">Now a short video of your face</h1>
        <p className="m-0 mt-1.5 text-ink-2">We compare it with your ID photo and check it’s really you, live.</p>
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        {TIPS.map((t) => (
          <div key={t.title} className="flex flex-col gap-1 rounded-card border border-line bg-surface p-3.5">
            <strong>{t.title}</strong>
            <span className="text-caption text-muted">{t.body}</span>
          </div>
        ))}
      </div>
      <div className="rounded-control bg-status-info p-3 text-body text-status-info-fg">
        Recording starts <strong>automatically</strong> when your face is in the oval, and stops after {VIDEO_SECONDS} seconds. You’ll be asked to turn your head and blink.
      </div>
      <Button tone="brand" block onClick={onReady}>
        I’m ready
      </Button>
    </div>
  );
}

export function BlockedView({ onTryAgain, onClose }: { onTryAgain: () => void; onClose: () => void }): ReactNode {
  return (
    <div className="flex flex-col gap-4">
      <span aria-hidden="true" className="flex size-[60px] items-center justify-center rounded-pill bg-status-warn text-[28px] font-extrabold text-status-warn-fg">
        !
      </span>
      <h1 className="m-0 font-display text-[26px] leading-tight">We can’t use your camera</h1>
      <p className="m-0 text-ink-2">Your browser is blocking camera access, or this device has no front camera. To record the video, allow the camera for this site in your browser’s settings, then try again.</p>
      <Button tone="brand" block onClick={onTryAgain}>
        Try again
      </Button>
      <Button variant="text" tone="brand" block onClick={onClose}>
        Back
      </Button>
    </div>
  );
}

type ViewProps = {
  phase: FacePhase;
  /** Seconds recorded so far. */
  t: number;
  /** The live stream, when there is one. The gate passes none and gets the dark frame. */
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  autoStart: boolean;
  onStart: () => void;
  onClose: () => void;
};

export function CameraView({ phase, t, videoRef, autoStart, onStart, onClose }: ViewProps): ReactNode {
  const recording = phase === 'recording';
  const prompt = promptAt(t);
  const title: Record<string, [string, string]> = {
    starting: ['Opening the camera', ''],
    searching: ['Looking for your face', 'Hold your phone at eye level'],
    ready: ['Put your face in the oval', 'Then tap Start recording'],
    detected: ['Face found. Hold still', 'Recording starts now'],
    lost: ['We lost your face', 'Move back into the oval'],
    saving: ['Done', 'Saving your video'],
  };
  const [heading, sub] = recording ? [prompt.title, prompt.sub] : (title[phase] ?? ['', '']);
  const stroke = phase === 'lost' ? 'stroke-on-ink-timer' : phase === 'searching' || phase === 'starting' || phase === 'ready' ? 'stroke-white/75' : 'stroke-brand-muted';
  const ring = recording ? 942 * (1 - t / VIDEO_SECONDS) : phase === 'saving' ? 0 : 942;

  return (
    <div className="relative flex h-dvh max-h-[844px] flex-col bg-black text-white">
      <header className="flex h-14 shrink-0 items-center gap-2 px-3">
        <button type="button" aria-label="Close camera" onClick={onClose} className="flex size-11 items-center justify-center rounded-pill text-white">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
        <span className="grow font-bold">Face video</span>
        {recording ? (
          <span className="flex items-center gap-1.5 text-body font-semibold text-on-ink-timer" aria-label="Recording">
            <span aria-hidden="true" className="size-2.5 animate-pulse rounded-pill bg-status-danger-fg" />
            {`0:0${Math.max(0, Math.ceil(VIDEO_SECONDS - t))}`}
          </span>
        ) : null}
      </header>

      <div className="relative min-h-0 grow overflow-hidden bg-ink-raised">
        <video ref={videoRef} playsInline muted autoPlay aria-label="Your camera" className="absolute inset-0 size-full -scale-x-100 object-cover" />
        <svg viewBox="0 0 390 600" preserveAspectRatio="xMidYMid slice" aria-hidden="true" className="absolute inset-0 size-full">
          <defs>
            <mask id="oval-hole">
              <rect width="390" height="600" fill="white" />
              <ellipse cx="195" cy="275" rx="128" ry="168" fill="black" />
            </mask>
          </defs>
          <rect width="390" height="600" className="fill-black/70" mask="url(#oval-hole)" />
          <ellipse cx="195" cy="275" rx="128" ry="168" fill="none" strokeWidth="4" strokeDasharray={phase === 'searching' ? '10 10' : undefined} className={stroke} />
          <ellipse cx="195" cy="275" rx="136" ry="176" fill="none" strokeWidth="5" strokeLinecap="round" strokeDasharray="942" strokeDashoffset={ring} className="stroke-on-ink-timer" style={{ opacity: recording || phase === 'saving' ? 1 : 0 }} transform="rotate(-90 195 275)" />
        </svg>
      </div>

      <div className="flex shrink-0 flex-col items-center gap-3 px-5 py-5 text-center">
        <strong className="text-[20px]" aria-live="polite">
          {heading}
        </strong>
        <span className="min-h-[1.4em] text-body text-on-ink-muted">{sub}</span>
        {phase === 'ready' && !autoStart ? (
          <Button tone="brand" block onClick={onStart}>
            Start recording
          </Button>
        ) : null}
      </div>
    </div>
  );
}

type FaceDetectorLike = { detect: (v: HTMLVideoElement) => Promise<unknown[]> };
type DetectorCtor = new (opts?: { fastMode?: boolean; maxDetectedFaces?: number }) => FaceDetectorLike;

/**
 * The logic. `onRecorded` receives the finished video; the screen uploads it. Nothing here touches the network, so a
 * failed upload can offer "Record again" without a stale stream or a half-written file to clean up.
 */
export function FaceCapture({ onRecorded, onClose }: { onRecorded: (video: Blob) => Promise<void> | void; onClose: () => void }): ReactNode {
  const [phase, setPhase] = useState<FacePhase>('tips');
  const [t, setT] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const timers = useRef<number[]>([]);
  const live = useRef(true);
  const Detector = (typeof window === 'undefined' ? undefined : (window as unknown as { FaceDetector?: DetectorCtor }).FaceDetector) ?? null;
  const detector = useRef<FaceDetectorLike | null>(null);
  // record() and search() call each other (a lost face goes back to searching); a ref breaks the cycle without a stale closure.
  const searchRef = useRef<() => void>(() => undefined);

  const clear = useCallback(() => {
    for (const id of timers.current) window.clearInterval(id);
    timers.current = [];
  }, []);

  const stopCamera = useCallback(() => {
    clear();
    if (recorder.current !== null && recorder.current.state !== 'inactive') {
      recorder.current.onstop = null;
      recorder.current.stop();
    }
    recorder.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  }, [clear]);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      stopCamera();
    };
  }, [stopCamera]);

  const record = useCallback((): void => {
    const media = stream.current;
    if (media === null) return;
    const type = pickVideoType((m) => MediaRecorder.isTypeSupported(m));
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(media, type === null ? undefined : { mimeType: type, videoBitsPerSecond: 1_200_000 });
    recorder.current = rec;
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = () => {
      clear();
      if (!live.current) return;
      setPhase('saving');
      const blob = new Blob(chunks, { type: rec.mimeType || type || 'video/webm' });
      stopCamera();
      void Promise.resolve(onRecorded(blob));
    };
    rec.start(250);
    setPhase('recording');
    setT(0);
    const started = Date.now();
    let missing = 0;
    const id = window.setInterval(() => {
      const seconds = (Date.now() - started) / 1000;
      setT(Math.min(seconds, VIDEO_SECONDS));
      if (seconds >= VIDEO_SECONDS) {
        window.clearInterval(id);
        if (rec.state !== 'inactive') rec.stop();
        return;
      }
      // Where the browser can see faces: losing it for ~1.5 s is the board's "We lost your face", and the take restarts.
      const v = videoRef.current;
      if (detector.current !== null && v !== null) {
        void detector.current.detect(v).then((faces) => {
          missing = faces.length === 0 ? missing + 1 : 0;
          if (missing >= 5 && rec.state === 'recording') {
            window.clearInterval(id);
            rec.onstop = null;
            rec.stop();
            setPhase('lost');
            timers.current.push(window.setTimeout(() => searchRef.current(), 1800) as unknown as number);
          }
        }).catch(() => undefined);
      }
    }, 300);
    timers.current.push(id);
  }, [clear, onRecorded, stopCamera]);

  const search = useCallback((): void => {
    if (detector.current === null) {
      setPhase('ready');
      return;
    }
    setPhase('searching');
    let hits = 0;
    const id = window.setInterval(() => {
      const v = videoRef.current;
      if (v === null || v.readyState < 2) return;
      void detector.current?.detect(v).then((faces) => {
        hits = faces.length > 0 ? hits + 1 : 0;
        if (hits >= 3) {
          window.clearInterval(id);
          setPhase('detected');
          timers.current.push(window.setTimeout(() => record(), 900) as unknown as number);
        }
      }).catch(() => undefined);
    }, 300);
    timers.current.push(id);
  }, [record]);
  searchRef.current = search;

  const open = useCallback(async (): Promise<void> => {
    setPhase('starting');
    try {
      const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 960 } }, audio: false });
      if (!live.current) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = media;
      const v = videoRef.current;
      if (v !== null) {
        v.srcObject = media;
        await v.play().catch(() => undefined);
      }
      detector.current = Detector === null ? null : new Detector({ fastMode: true, maxDetectedFaces: 1 });
      search();
    } catch {
      if (live.current) setPhase('blocked');
    }
  }, [Detector, search]);

  if (phase === 'tips') return <TipsView onReady={() => void open()} />;
  if (phase === 'blocked') {
    return (
      <BlockedView
        onTryAgain={() => void open()}
        onClose={() => {
          stopCamera();
          onClose();
        }}
      />
    );
  }
  return (
    <CameraView
      phase={phase}
      t={t}
      videoRef={videoRef}
      autoStart={Detector !== null}
      onStart={record}
      onClose={() => {
        stopCamera();
        setPhase('tips');
        onClose();
      }}
    />
  );
}

