import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCameraDevice, useCameraPermission } from 'react-native-vision-camera';
import { Camera as FaceCamera } from 'react-native-vision-camera-face-detector';

export default function App() {
  const device = useCameraDevice('front');
  const { hasPermission, requestPermission } = useCameraPermission();
  const cameraRef = useRef(null);

  const [cameraOn, setCameraOn] = useState(false);
  const [faces, setFaces] = useState([]);
  const [photo, setPhoto] = useState('');

  // Blink gating (no auto-capture)
  const OPEN_T = 0.6;            // slightly looser than before to help testing
  const CLOSED_T = 0.3;
  const CONSEC = 3;
  const CLOSE_MAX_MS = 900;
  const TOTAL_TIMEOUT_MS = 7000;

  const fsmRef = useRef({ state: 'WAIT_OPEN', openCount: 0, closeCount: 0, t0: 0, lastSeen: 0 });
  const [livenessPassed, setLivenessPassed] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [canCapture, setCanCapture] = useState(false);
  const countdownTimerRef = useRef(null);
  const [debugOpen, setDebugOpen] = useState(null); // shows openness 0..1

  const facePresent = useMemo(() => faces.length === 1, [faces]);

  useEffect(() => () => clearCountdown(), []);

  useEffect(() => {
    if (countdown > 0) {
      countdownTimerRef.current = setTimeout(() => setCountdown(n => n - 1), 1000);
    } else {
      clearCountdown();
      if (livenessPassed) setCanCapture(true);
    }
    return () => clearTimeout(countdownTimerRef.current);
  }, [countdown, livenessPassed]);

  const clearCountdown = () => {
    if (countdownTimerRef.current) {
      clearTimeout(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
  };

  const resetFSM = () => {
    fsmRef.current = { state: 'WAIT_OPEN', openCount: 0, closeCount: 0, t0: 0, lastSeen: 0 };
  };

  const fullReset = () => {
    resetFSM();
    setLivenessPassed(false);
    setCanCapture(false);
    setCountdown(0);
    setDebugOpen(null);
  };

  const askPermissionAndStart = async () => {
    if (!hasPermission) {
      const ok = await requestPermission();
      if (!ok) {
        Toast.show({ type: 'error', text1: 'Camera permission is required' });
        return;
      }
    }
    if (!device) {
      Toast.show({ type: 'error', text1: 'No camera device found' });
      return;
    }
    setPhoto('');
    setCameraOn(true);
    fullReset();
  };

  const backToHome = () => {
    setCameraOn(false);
    setPhoto('');
    fullReset();
  };

  const retake = () => {
    setPhoto('');
    setCameraOn(true);
    fullReset();
  };

  const getEyeOpenness = (face) => {
    const candidates = [
      face?.leftEyeOpenProbability, face?.rightEyeOpenProbability,
      face?.leftEyeOpen, face?.rightEyeOpen,
      face?.leftEye?.probability, face?.rightEye?.probability,
    ].filter(v => typeof v === 'number');
    if (!candidates.length) return null;
    return Math.max(...candidates);
  };

  const onFaces = (detected) => {
    const arr = Array.isArray(detected) ? detected : [];
    setFaces(arr);

    if (arr.length !== 1) {
      if ((livenessPassed || canCapture || countdown > 0) && cameraOn) {
        Toast.show({ type: 'info', text1: 'Show exactly one face' });
      }
      setLivenessPassed(false);
      setCanCapture(false);
      setCountdown(0);
      setDebugOpen(null);
      resetFSM();
      return;
    }

    // --- BLINK FSM ---
    const face = arr[0];
    const openness = getEyeOpenness(face);
    setDebugOpen(typeof openness === 'number' ? Number(openness.toFixed(2)) : null);

    if (typeof openness !== 'number') {
      // If you see null here, classification probably isn't enabled (see faceDetectionOptions below)
      return;
    }

    const now = Date.now();
    const f = fsmRef.current;
    f.lastSeen = now;

    if (openness >= OPEN_T) {
      f.openCount += 1;
      f.closeCount = 0;
    } else if (openness <= CLOSED_T) {
      f.closeCount += 1;
      f.openCount = 0;
    } else {
      f.openCount = Math.max(0, f.openCount - 1);
      f.closeCount = Math.max(0, f.closeCount - 1);
    }

    if (!f.t0) f.t0 = now;
    if (now - f.t0 > TOTAL_TIMEOUT_MS) {
      resetFSM();
      return;
    }

    if (f.state === 'WAIT_OPEN' && f.openCount >= CONSEC) {
      f.state = 'WAIT_CLOSE';
      f.t0 = now;
    } else if (f.state === 'WAIT_CLOSE' && f.closeCount >= CONSEC) {
      f.state = 'WAIT_REOPEN';
      f.t0 = now;
    } else if (f.state === 'WAIT_REOPEN') {
      if (now - f.t0 > CLOSE_MAX_MS) {
        resetFSM();
        return;
      }
      if (f.openCount >= CONSEC && !livenessPassed) {
        setLivenessPassed(true);
        setCanCapture(false);
        setCountdown(3); // 3..2..1 then unlock shutter
        Toast.show({ type: 'success', text1: 'Blink detected — ready for capture' });
      }
    }
  };

  const takeShot = async () => {
    if (!cameraRef.current) return;
    if (!canCapture) {
      Toast.show({ type: 'info', text1: 'Blink to enable the shutter' });
      return;
    }
    try {
      const shot = await cameraRef.current.takePhoto({});
      setPhoto(`file://${shot.path}`);
      setCameraOn(false);
    } catch (e) {
      Toast.show({ type: 'error', text1: 'Capture failed', text2: String(e?.message || e) });
    }
  };

  // ---------- UI ----------
  if (photo) {
    return (
      <View style={styles.container}>
        <Image source={{ uri: photo }} style={styles.preview} />
        <View style={styles.bottomRow}>
          <TouchableOpacity style={styles.secondaryBtn} onPress={retake}>
            <Text style={styles.secondaryText}>Retake</Text>
          </TouchableOpacity>
        </View>
        <Toast />
      </View>
    );
  }

  if (!cameraOn) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Face Verification</Text>
        <Text style={styles.subtitle}>Tap below to activate your camera.</Text>
        <TouchableOpacity onPress={askPermissionAndStart} style={styles.primaryBtn}>
          <Text style={styles.primaryText}>Activate Camera</Text>
        </TouchableOpacity>
        {!device && <Text style={styles.warn}>No camera device found</Text>}
        <Toast />
      </View>
    );
  }

  if (!device || !hasPermission) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
        <Text style={styles.subtitle}>{device ? 'Waiting for permission…' : 'No camera device found'}</Text>
        <Toast />
      </View>
    );
  }

  const fsmState = fsmRef.current.state;

  // IMPORTANT: classificationMode: 'all' to get eye probabilities
  const faceDetectionOptions = {
    performanceMode: 'fast',
    classificationMode: 'all', // <-- REQUIRED for left/rightEyeOpenProbability
    contourMode: 'none',
    landmarkMode: 'none',
    trackingEnabled: false,
    minFaceSize: 0.15,         // make sure face is not too small
  };

  return (
    <View style={styles.container}>
      <View style={{ flex: 1, borderRadius: 10, overflow: 'hidden' }}>
        <FaceCamera
          ref={cameraRef}
          style={styles.camera}
          device={device}
          isActive={true}
          photo={true}
          faceDetectionCallback={onFaces}
          faceDetectionOptions={faceDetectionOptions}
        />

        {/* Back button (lower-left) */}
        <View style={styles.backWrap}>
          <TouchableOpacity onPress={backToHome} style={styles.backBtn}>
            <Text style={styles.backText}>‹ Back</Text>
          </TouchableOpacity>
        </View>

        {/* Top instructions */}
        <View style={styles.overlayTop}>
          {faces.length === 0 && <Text style={styles.overlayText}>Show your face in the frame</Text>}
          {faces.length > 1 && <Text style={styles.overlayText}>Only one person please</Text>}
          {facePresent && !livenessPassed && (
            <Text style={styles.overlayText}>
              {fsmState === 'WAIT_OPEN' ? 'Step 1: Eyes open'
               : fsmState === 'WAIT_CLOSE' ? 'Step 2: Blink (close eyes)'
               : 'Step 3: Open eyes again'}
            </Text>
          )}
          {livenessPassed && (
            <Text style={styles.overlayText}>
              Ready for capture {countdown > 0 ? `• ${countdown}` : ''}
            </Text>
          )}
          {typeof debugOpen === 'number' && (
            <Text style={styles.debugText}>Eye openness: {debugOpen}</Text>
          )}
        </View>

        {/* Faces counter (debug) */}
        <View style={styles.overlayCounter}>
          <Text style={styles.counterText}>Faces: {faces.length}</Text>
        </View>
      </View>

      {/* Shutter: enabled only after countdown finished */}
      <View style={styles.bottomRow}>
        <TouchableOpacity
          onPress={takeShot}
          style={[styles.shutterButton, !canCapture && styles.shutterDisabled]}
          disabled={!canCapture}
        />
        {!canCapture && <Text style={styles.hint}>Blink to enable the shutter</Text>}
      </View>

      <Toast />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700', marginBottom: 8 },
  subtitle: { color: '#aaa', fontSize: 14, textAlign: 'center', marginBottom: 20 },
  primaryBtn: { backgroundColor: '#4F8EF7', paddingHorizontal: 18, paddingVertical: 12, borderRadius: 12 },
  primaryText: { color: '#fff', fontWeight: '700' },
  secondaryBtn: { borderColor: '#fff', borderWidth: 1.5, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12 },
  secondaryText: { color: '#fff', fontWeight: '600' },
  warn: { marginTop: 8, color: '#f77' },

  camera: { flex: 1 },

  overlayTop: {
    position: 'absolute', top: 16, alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, alignItems: 'center'
  },
  overlayText: { color: '#fff', fontWeight: '700' },
  debugText: { color: '#ddd', fontSize: 12, marginTop: 2 },

  overlayCounter: {
    position: 'absolute', top: 16, right: 16,
    backgroundColor: 'rgba(0,0,0,0.45)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10
  },
  counterText: { color: '#fff', fontWeight: '600', fontSize: 12 },

  bottomRow: { position: 'absolute', bottom: 28, width: '100%', alignItems: 'center', gap: 8 },

  backWrap: { position: 'absolute', bottom: 28, left: 20 },
  backBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.45)' },
  backText: { color: '#fff', fontWeight: '700' },

  shutterButton: { width: 70, height: 70, borderRadius: 35, backgroundColor: '#fff' },
  shutterDisabled: { backgroundColor: '#777' },
  hint: { color: '#ccc', marginTop: 6, fontSize: 12 },

  preview: { flex: 1, borderRadius: 10, margin: 12 },
});
