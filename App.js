// App.jsx
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Toast from "react-native-toast-message";
import { useCameraDevice, useCameraPermission } from "react-native-vision-camera";
import { Camera as FaceCamera } from "react-native-vision-camera-face-detector";
import * as ImagePicker from "expo-image-picker";

/* =================== CONFIG =================== */
const LUXAND_API_KEY = "c3cc8b5ab1a747eca4977a76ad173ffd";
const LUXAND_COMPARE_URL = "https://api.luxand.cloud/photo/similarity";
const MATCH_THRESHOLD = 0.8;

const REQUIRED_MOVES = 3;
const OPEN_T = 0.6;
const CLOSED_T = 0.3;
const CONSEC = 3;
const CLOSE_MAX_MS = 900;
const TOTAL_TIMEOUT_MS = 7000;

const ACTIONS = ["TURN_LEFT", "TURN_RIGHT", "LOOK_UP", "LOOK_DOWN"];
const ACTION_LABEL = {
  TURN_LEFT: "Turn head LEFT",
  TURN_RIGHT: "Turn head RIGHT",
  LOOK_UP: "Look UP",
  LOOK_DOWN: "Look DOWN",
};
const ACTION_CONSEC = 3;
const ACTION_TIMEOUT_MS = 5000;
const YAW_DEG = 15;
const PITCH_DEG = 12;

/* =================== UTILS =================== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileUri = (p) => (p?.startsWith("file://") ? p : `file://${p}`);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Normalize pose fields across plugin variants */
const getAngles = (f) => {
  const yaw =
    (isNum(f?.yawAngle) ? f.yawAngle : null) ??
    (isNum(f?.headEulerAngleY) ? f.headEulerAngleY : null) ??
    (isNum(f?.yaw) ? f.yaw : 0);

  const pitch =
    (isNum(f?.pitchAngle) ? f.pitchAngle : null) ??
    (isNum(f?.headEulerAngleX) ? f.headEulerAngleX : null) ??
    (isNum(f?.pitch) ? f.pitch : 0);

  const roll =
    (isNum(f?.rollAngle) ? f.rollAngle : null) ??
    (isNum(f?.headEulerAngleZ) ? f.headEulerAngleZ : null) ??
    (isNum(f?.roll) ? f.roll : 0);

  return { yaw: yaw ?? 0, pitch: pitch ?? 0, roll: roll ?? 0 };
};

/* =================== APP =================== */
export default function App() {
  const device = useCameraDevice("front");
  const { hasPermission, requestPermission } = useCameraPermission();
  const cameraRef = useRef(null);

  // Images
  const [selfieUri, setSelfieUri] = useState("");
  const [galleryUri, setGalleryUri] = useState("");

  // Camera UI
  const [cameraOn, setCameraOn] = useState(false);
  const [isComparing, setIsComparing] = useState(false);
  const [compareResult, setCompareResult] = useState(null);

  // Face + liveness
  const [faces, setFaces] = useState([]);
  const [blinkPassed, setBlinkPassed] = useState(false);
  const [successCount, setSuccessCount] = useState(0);
  const [canCapture, setCanCapture] = useState(false);
  const [debugOpen, setDebugOpen] = useState(null);
  const [debugPose, setDebugPose] = useState(null);

  // Blink FSM
  const fsmRef = useRef({ state: "WAIT_OPEN", openCount: 0, closeCount: 0, t0: 0, lastSeen: 0 });

  // Prevent extra prompts after finishing
  const doneRef = useRef(false);

  // Refs to make auto-capture robust against stale closures
  const canCaptureRef = useRef(false);
  const autoTimerRef = useRef(null);

  // Action state
  const actionRef = useRef({
    active: false,
    target: null,
    baseline: { yaw: 0, pitch: 0 },
    consec: 0,
    startedAt: 0,
    deadline: 0,
    lastTarget: null,
  });
  const [actionTarget, setActionTarget] = useState(null);
  const [timeLeft, setTimeLeft] = useState(0);

  // Keep detection options STABLE across renders
  const faceOpts = useRef({
    performanceMode: "fast",
    classificationMode: "all",
    landmarkMode: "none",
    contourMode: "none",
    trackingEnabled: false,
  }).current;

  // Auto-capture when ready (uses refs to avoid stale state)
  useEffect(() => {
    const ready = blinkPassed && successCount >= REQUIRED_MOVES;
    setCanCapture(ready);
    canCaptureRef.current = ready;
    doneRef.current = ready;

    // clear any previous timer
    if (autoTimerRef.current) {
      clearTimeout(autoTimerRef.current);
      autoTimerRef.current = null;
    }

    if (ready && cameraOn && cameraRef.current) {
      Toast.hide();
      Toast.show({ type: "info", text1: "Auto-capturing in 3 seconds..." });
      autoTimerRef.current = setTimeout(async () => {
        if (!cameraRef.current || !canCaptureRef.current) return;
        await captureNow(); // direct capture without checking state again
      }, 3000);
    }

    return () => {
      if (autoTimerRef.current) {
        clearTimeout(autoTimerRef.current);
        autoTimerRef.current = null;
      }
    };
  }, [blinkPassed, successCount, cameraOn]);

  // Action countdown tick
  useEffect(() => {
    if (!actionRef.current.active) return;
    const id = setInterval(() => {
      const now = Date.now();
      const left = Math.max(0, Math.ceil((actionRef.current.deadline - now) / 1000));
      setTimeLeft(left);
      if (left <= 0) rerollAction(); // timeout → new action
    }, 250);
    return () => clearInterval(id);
  }, [actionTarget]);

  /* -------- helpers -------- */
  const resetFSM = () => {
    fsmRef.current = { state: "WAIT_OPEN", openCount: 0, closeCount: 0, t0: 0, lastSeen: 0 };
  };

  const fullReset = () => {
    resetFSM();
    setBlinkPassed(false);
    setSuccessCount(0);
    setCanCapture(false);
    canCaptureRef.current = false;
    setDebugOpen(null);
    setDebugPose(null);
    setCompareResult(null);
    doneRef.current = false;

    if (autoTimerRef.current) {
      clearTimeout(autoTimerRef.current);
      autoTimerRef.current = null;
    }

    actionRef.current = {
      active: false,
      target: null,
      baseline: { yaw: 0, pitch: 0 },
      consec: 0,
      startedAt: 0,
      deadline: 0,
      lastTarget: null,
    };
    setActionTarget(null);
    setTimeLeft(0);
  };

  const hardResetAll = () => {
    setSelfieUri("");
    setGalleryUri("");
    setFaces([]);
    setCameraOn(false);
    fullReset();
  };

  const askPermissionAndStart = async () => {
    if (!hasPermission && !(await requestPermission())) {
      Toast.show({ type: "error", text1: "Camera permission required" });
      return;
    }
    if (!device) {
      Toast.show({ type: "error", text1: "No camera found" });
      return;
    }
    setSelfieUri("");
    setCompareResult(null);
    setCameraOn(true);
    fullReset();
  };

  const eyeOpenness = (f) => {
    const vals = [f?.leftEyeOpenProbability, f?.rightEyeOpenProbability, f?.leftEyeOpen, f?.rightEyeOpen]
      .filter((v) => isNum(v) && v >= 0 && v <= 1);
    return vals.length ? Math.max(...vals) : null;
  };

  // Random target, avoid repeating the previous one
  const pickTarget = (last) => {
    const pool = ACTIONS.filter((a) => a !== last);
    return pool[Math.floor(Math.random() * pool.length)];
  };

  const startAction = (face) => {
    if (doneRef.current) return;
    const { yaw, pitch } = getAngles(face);
    const target = pickTarget(actionRef.current.lastTarget);
    const now = Date.now();
    actionRef.current = {
      active: true,
      target,
      baseline: { yaw, pitch },
      consec: 0,
      startedAt: now,
      deadline: now + ACTION_TIMEOUT_MS,
      lastTarget: target,
    };
    setActionTarget(target);
    setTimeLeft(Math.ceil(ACTION_TIMEOUT_MS / 1000));
    Toast.show({ type: "info", text1: `Move ${successCount + 1}/${REQUIRED_MOVES}: ${ACTION_LABEL[target]}` });
  };

  const rerollAction = () => {
    if (doneRef.current) {
      actionRef.current.active = false;
      setActionTarget(null);
      setTimeLeft(0);
      return;
    }
    const current = faces?.[0];
    if (!current) {
      actionRef.current.active = false;
      setActionTarget(null);
      setTimeLeft(0);
      return;
    }
    startAction(current);
  };

  const actionSatisfied = (target, baseline, current) => {
    const dyaw = current.yaw - baseline.yaw;
    const dpitch = current.pitch - baseline.pitch;
    switch (target) {
      case "TURN_LEFT":  return dyaw >= YAW_DEG;
      case "TURN_RIGHT": return dyaw <= -YAW_DEG;
      case "LOOK_UP":    return dpitch <= -PITCH_DEG;
      case "LOOK_DOWN":  return dpitch >= PITCH_DEG;
      default: return false;
    }
  };

  /* -------- main face callback -------- */
  const onFaces = (arr) => {
    setFaces(arr);

    if (doneRef.current) return;

    if (arr.length !== 1) {
      const now = Date.now();
      const f = fsmRef.current;
      if (f.lastSeen && now - f.lastSeen > 1000) resetFSM();
      setDebugOpen(null);
      setDebugPose(null);
      return;
    }

    const face = arr[0];
    const open = eyeOpenness(face);
    if (open == null) {
      setDebugOpen("—");
    } else {
      setDebugOpen(open.toFixed(2));
    }

    const now = Date.now();
    const fsm = fsmRef.current;
    fsm.lastSeen = now;

    const angles = getAngles(face);
    setDebugPose(`yaw ${angles.yaw.toFixed(1)} • pitch ${angles.pitch.toFixed(1)}`);

    // Blink phase
    if (!blinkPassed) {
      if (isNum(open)) {
        if (open >= OPEN_T) { fsm.openCount++; fsm.closeCount = 0; }
        else if (open <= CLOSED_T) { fsm.closeCount++; fsm.openCount = 0; }
      }

      if (!fsm.t0) fsm.t0 = now;
      if (now - fsm.t0 > TOTAL_TIMEOUT_MS) return resetFSM();

      if (fsm.state === "WAIT_OPEN" && fsm.openCount >= CONSEC) {
        fsm.state = "WAIT_CLOSE"; fsm.t0 = now;
      } else if (fsm.state === "WAIT_CLOSE" && fsm.closeCount >= CONSEC) {
        fsm.state = "WAIT_REOPEN"; fsm.t0 = now;
      } else if (fsm.state === "WAIT_REOPEN") {
        if (now - fsm.t0 > CLOSE_MAX_MS) return resetFSM();
        if (fsm.openCount >= CONSEC) {
          setBlinkPassed(true);
          Toast.hide();
          Toast.show({ type: "success", text1: "Blink detected" });
          startAction(face);
        }
      }
      return;
    }

    // Action phase
    if (successCount < REQUIRED_MOVES) {
      if (!actionRef.current.active) startAction(face);

      if (Date.now() > actionRef.current.deadline) return rerollAction();

      if (actionSatisfied(actionRef.current.target, actionRef.current.baseline, angles)) {
        actionRef.current.consec++;
        if (actionRef.current.consec >= ACTION_CONSEC) {
          const next = successCount + 1;
          setSuccessCount(next);
          actionRef.current.active = false;
          setActionTarget(null);
          setTimeLeft(0);

          if (next >= REQUIRED_MOVES) {
            Toast.hide();
            Toast.show({ type: "success", text1: "Liveness passed — capturing soon" });
            doneRef.current = true;
            canCaptureRef.current = true;
            setCanCapture(true);
          } else {
            setTimeout(() => startAction(face), 300);
          }
        }
      } else {
        actionRef.current.consec = 0;
      }
    }
  };

  /* -------- capture & compare -------- */
  const captureNow = async () => {
    try {
      const shot = await cameraRef.current.takePhoto({});
      const uri = fileUri(shot.path);
      setSelfieUri(uri);
      setCameraOn(false);
    } catch (e) {
      Toast.show({ type: "error", text1: "Capture failed", text2: String(e?.message || e) });
    }
  };

  const takeShot = async () => {
    if (!cameraRef.current || !canCapture) {
      Toast.show({ type: "info", text1: `Complete blink + ${REQUIRED_MOVES} moves first` });
      return;
    }
    await captureNow();
  };

  const pickFromGallery = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Toast.show({ type: "error", text1: "Permission denied", text2: "Enable photo access to pick an image." });
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 1,
      allowsEditing: false,
    });
    if (res.canceled) return;
    const uri = res.assets?.[0]?.uri;
    if (!uri) {
      Toast.show({ type: "error", text1: "No image selected" });
      return;
    }
    setGalleryUri(uri);
  };

  const compareFaces = async () => {
    if (!selfieUri || !galleryUri) {
      Toast.show({ type: "info", text1: "Add both photos first" });
      return;
    }
    try {
      setIsComparing(true);
      setCompareResult(null);

      const form = new FormData();
      form.append("threshold", String(MATCH_THRESHOLD));
      form.append("face1", { uri: selfieUri, name: "selfie.jpg", type: "image/jpeg" });
      form.append("face2", { uri: galleryUri, name: "reference.jpg", type: "image/jpeg" });

      const resp = await fetch(LUXAND_COMPARE_URL, {
        method: "POST",
        headers: { token: LUXAND_API_KEY, Accept: "application/json" },
        body: form,
      });

      const raw = await resp.text();
      let json; try { json = JSON.parse(raw); } catch { json = null; }
      if (!resp.ok) {
        const msg = json?.error || raw || `HTTP ${resp.status}`;
        throw new Error(msg);
      }

      const similarity =
        typeof json?.similarity === "number" ? json.similarity :
        typeof json?.score === "number" ? json.score : 0;

      const matched =
        typeof json?.similar === "boolean" ? json.similar : similarity >= MATCH_THRESHOLD;

      setCompareResult({ similarity, matched });

      Toast.show({
        type: matched ? "success" : "error",
        text1: matched ? "Face match!" : "Not a match",
        text2: `Similarity: ${(similarity * 100).toFixed(1)}%`,
      });
    } catch (e) {
      Toast.show({ type: "error", text1: "Compare failed", text2: String(e?.message || e) });
    } finally {
      setIsComparing(false);
    }
  };

  /* -------- camera screen -------- */
  if (cameraOn) {
    return (
      <View style={styles.cameraContainer}>
        <FaceCamera
          ref={cameraRef}
          style={styles.camera}
          device={device}
          isActive
          photo
          faceDetectionCallback={onFaces}
          faceDetectionOptions={faceOpts}
        />

        <TouchableOpacity onPress={hardResetAll} style={styles.backBtn}>
          <Text style={styles.backText}>‹ Back</Text>
        </TouchableOpacity>

        <View style={styles.overlayTop}>
          <Text style={styles.overlayText}>
            {!blinkPassed
              ? "Blink to verify liveness"
              : successCount >= REQUIRED_MOVES
              ? "Liveness passed — ready to capture"
              : actionTarget
              ? `Move ${successCount + 1}/${REQUIRED_MOVES}: ${ACTION_LABEL[actionTarget]}${timeLeft ? ` • ${timeLeft}s` : ""}`
              : "Get ready…"}
          </Text>
          {debugOpen !== null && <Text style={styles.debugText}>Eye: {debugOpen}</Text>}
          {debugPose && <Text style={styles.debugText}>{debugPose}</Text>}
        </View>

        <View style={styles.bottomRow}>
          <TouchableOpacity
            onPress={takeShot}
            style={[styles.shutter, !canCapture && styles.shutterDisabled]}
            disabled={!canCapture}
          />
        </View>
        <Toast />
      </View>
    );
  }

  /* -------- main UI -------- */
  return (
    <View style={styles.mainContainer}>
      <Text style={styles.mainTitle}>Face Comparison</Text>

      <View style={styles.row}>
        <View style={styles.box}>
          <Text style={styles.label}>1. Capture Selfie</Text>
          {selfieUri ? (
            <Image source={{ uri: selfieUri }} style={styles.preview} />
          ) : (
            <Text style={styles.placeholder}>No image</Text>
          )}
          <TouchableOpacity onPress={askPermissionAndStart} style={styles.primaryBtn}>
            <Text style={styles.primaryText}>{selfieUri ? "Retake" : "Open Detector"}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.box}>
          <Text style={styles.label}>2. Reference (Gallery)</Text>
          {galleryUri ? (
            <Image source={{ uri: galleryUri }} style={styles.preview} />
          ) : (
            <Text style={styles.placeholder}>No image</Text>
          )}
          <TouchableOpacity onPress={pickFromGallery} style={styles.primaryBtn}>
            <Text style={styles.primaryText}>{galleryUri ? "Change Photo" : "Pick from Gallery"}</Text>
          </TouchableOpacity>
        </View>
      </View>

      <TouchableOpacity
        onPress={compareFaces}
        disabled={!selfieUri || !galleryUri || isComparing}
        style={[styles.compareBtn, (!selfieUri || !galleryUri || isComparing) && { opacity: 0.6 }]}
      >
        {isComparing ? <ActivityIndicator color="#fff" /> : <Text style={styles.compareText}>Compare Faces</Text>}
      </TouchableOpacity>

      {compareResult && (
        <Text style={[styles.resultText, { color: compareResult.matched ? "#16A34A" : "#DC2626" }]}>
          {compareResult.matched ? "✅ Face Match!" : "❌ Not a Match"} ({(compareResult.similarity * 100).toFixed(1)}%)
        </Text>
      )}

      <Toast />
    </View>
  );
}

/* =================== STYLES =================== */
const styles = StyleSheet.create({
  mainContainer: {
    flex: 1,
    backgroundColor: "#fff",
    alignItems: "center",
    paddingTop: 50,
    paddingHorizontal: 12,
  },
  mainTitle: { fontSize: 22, fontWeight: "700", color: "#111", marginBottom: 20 },
  row: { flexDirection: "row", gap: 10, width: "100%" },
  box: {
    flex: 1,
    borderWidth: 2,
    borderStyle: "dashed",
    borderColor: "#9CA3AF",
    borderRadius: 12,
    backgroundColor: "#f9fafb",
    padding: 12,
    alignItems: "center",
  },
  label: { fontWeight: "700", color: "#111", marginBottom: 8 },
  placeholder: { color: "#9CA3AF", marginTop: 40 },
  preview: { width: "100%", aspectRatio: 3 / 4, borderRadius: 8, marginBottom: 10 },
  primaryBtn: { backgroundColor: "#2563EB", paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8 },
  primaryText: { color: "#fff", fontWeight: "600" },
  compareBtn: { backgroundColor: "#16A34A", marginTop: 24, paddingVertical: 12, paddingHorizontal: 28, borderRadius: 12 },
  compareText: { color: "#fff", fontWeight: "800", fontSize: 16 },
  resultText: { marginTop: 14, fontWeight: "700", fontSize: 16 },

  cameraContainer: { flex: 1, backgroundColor: "#000", justifyContent: "center" },
  camera: { flex: 1 },
  backBtn: {
    position: "absolute",
    bottom: 30,
    left: 20,
    padding: 8,
    backgroundColor: "rgba(0,0,0,0.5)",
    borderRadius: 10,
  },
  backText: { color: "#fff", fontWeight: "700" },
  overlayTop: {
    position: "absolute",
    top: 16,
    alignSelf: "center",
    backgroundColor: "rgba(0,0,0,0.5)",
    padding: 10,
    borderRadius: 10,
  },
  overlayText: { color: "#fff", fontWeight: "700" },
  debugText: { color: "#ddd", fontSize: 12, marginTop: 2 },
  bottomRow: { position: "absolute", bottom: 28, width: "100%", alignItems: "center" },
  shutter: { width: 70, height: 70, borderRadius: 35, backgroundColor: "#fff" },
  shutterDisabled: { backgroundColor: "#777" },
});
