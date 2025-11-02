// App.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
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

// 🔑 Luxand
const LUXAND_API_KEY = "c3cc8b5ab1a747eca4977a76ad173ffd";
const LUXAND_COMPARE_URL = "https://api.luxand.cloud/photo/similarity";
const MATCH_THRESHOLD = 0.8;

export default function App() {
  const device = useCameraDevice("front");
  const { hasPermission, requestPermission } = useCameraPermission();
  const cameraRef = useRef(null);

  const [cameraOn, setCameraOn] = useState(false);
  const [faces, setFaces] = useState([]);
  const [selfieUri, setSelfieUri] = useState("");
  const [galleryUri, setGalleryUri] = useState("");
  const [livenessPassed, setLivenessPassed] = useState(false);
  const [canCapture, setCanCapture] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [debugOpen, setDebugOpen] = useState(null);
  const [compareResult, setCompareResult] = useState(null);
  const [isComparing, setIsComparing] = useState(false);

  // Blink FSM
  const OPEN_T = 0.6, CLOSED_T = 0.3, CONSEC = 3, CLOSE_MAX_MS = 900, TOTAL_TIMEOUT_MS = 7000;
  const fsmRef = useRef({ state: "WAIT_OPEN", openCount: 0, closeCount: 0, t0: 0, lastSeen: 0 });
  const countdownRef = useRef(null);
  const facePresent = useMemo(() => faces.length === 1, [faces]);

  useEffect(() => () => clearTimeout(countdownRef.current), []);

  useEffect(() => {
    if (countdown > 0) {
      countdownRef.current = setTimeout(() => setCountdown(n => n - 1), 1000);
    } else if (livenessPassed) {
      setCanCapture(true);
    }
    return () => clearTimeout(countdownRef.current);
  }, [countdown, livenessPassed]);

  const resetFSM = () => {
    fsmRef.current = { state: "WAIT_OPEN", openCount: 0, closeCount: 0, t0: 0, lastSeen: 0 };
  };
  const fullReset = () => {
    resetFSM();
    setLivenessPassed(false);
    setCanCapture(false);
    setCountdown(0);
    setDebugOpen(null);
    setCompareResult(null);
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

  const getEyeOpenness = (f) =>
    Math.max(
      ...[
        f?.leftEyeOpenProbability,
        f?.rightEyeOpenProbability,
        f?.leftEyeOpen,
        f?.rightEyeOpen,
      ].filter((v) => typeof v === "number")
    );

  const onFaces = (arr) => {
    setFaces(arr);
    if (arr.length !== 1) {
      fullReset();
      return;
    }
    const face = arr[0];
    const open = getEyeOpenness(face);
    if (isNaN(open)) return;
    const now = Date.now(), f = fsmRef.current;
    f.lastSeen = now;

    if (open >= OPEN_T) { f.openCount++; f.closeCount = 0; }
    else if (open <= CLOSED_T) { f.closeCount++; f.openCount = 0; }

    if (!f.t0) f.t0 = now;
    if (now - f.t0 > TOTAL_TIMEOUT_MS) return resetFSM();

    if (f.state === "WAIT_OPEN" && f.openCount >= CONSEC) { f.state = "WAIT_CLOSE"; f.t0 = now; }
    else if (f.state === "WAIT_CLOSE" && f.closeCount >= CONSEC) { f.state = "WAIT_REOPEN"; f.t0 = now; }
    else if (f.state === "WAIT_REOPEN") {
      if (now - f.t0 > CLOSE_MAX_MS) return resetFSM();
      if (f.openCount >= CONSEC && !livenessPassed) {
        setLivenessPassed(true);
        setCanCapture(false);
        setCountdown(3);
        Toast.show({ type: "success", text1: "Blink detected — ready for capture" });
      }
    }
    setDebugOpen(open.toFixed(2));
  };

  const takeShot = async () => {
    if (!cameraRef.current || !canCapture) {
      Toast.show({ type: "info", text1: "Blink first to unlock shutter" });
      return;
    }
    try {
      const shot = await cameraRef.current.takePhoto({});
      const uri = shot.path.startsWith("file://") ? shot.path : `file://${shot.path}`;
      setSelfieUri(uri);
      setCameraOn(false);
    } catch (e) {
      Toast.show({ type: "error", text1: "Capture failed", text2: String(e?.message || e) });
    }
  };

  // Gallery picker (expo-image-picker)
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

  // ---- Luxand compare (normalized to handle {similarity} OR {score, similar})
  const compareFaces = async () => {
    if (!selfieUri || !galleryUri) {
      Toast.show({ type: "info", text1: "Add both photos first" });
      return;
    }
    try {
      setIsComparing(true);
      setCompareResult(null);

      const form = new FormData();
      form.append("threshold", MATCH_THRESHOLD.toString());
      form.append("face1", { uri: selfieUri, name: "selfie.jpg", type: "image/jpeg" });
      form.append("face2", { uri: galleryUri, name: "reference.jpg", type: "image/jpeg" });

      const resp = await fetch(LUXAND_COMPARE_URL, {
        method: "POST",
        headers: { token: LUXAND_API_KEY, Accept: "application/json" },
        body: form, // do NOT set Content-Type manually
      });

      const raw = await resp.text();
      let json;
      try { json = JSON.parse(raw); } catch { json = null; }

      if (!resp.ok) {
        const msg = json?.error || raw || `HTTP ${resp.status}`;
        throw new Error(msg);
      }

      // Luxand variants:
      // A) { similarity: number }
      // B) { score: number, similar: boolean }
      const similarity =
        typeof json?.similarity === "number"
          ? json.similarity
          : typeof json?.score === "number"
          ? json.score
          : 0;

      const matched =
        typeof json?.similar === "boolean"
          ? json.similar
          : similarity >= MATCH_THRESHOLD;

      setCompareResult({ similarity, matched });

      Toast.show({
        type: matched ? "success" : "error",
        text1: matched ? "Face match!" : "Not a match",
        text2: `Similarity: ${(similarity * 100).toFixed(1)}%`,
      });

      console.log("Luxand response:", json);
    } catch (e) {
      Toast.show({ type: "error", text1: "Compare failed", text2: String(e?.message || e) });
      console.warn("Luxand compare error:", e);
    } finally {
      setIsComparing(false);
    }
  };

  // ---- Camera screen
  if (cameraOn)
    return (
      <View style={styles.cameraContainer}>
        <FaceCamera
          ref={cameraRef}
          style={styles.camera}
          device={device}
          isActive
          photo
          faceDetectionCallback={onFaces}
          faceDetectionOptions={{ classificationMode: "all" }}
        />
        <TouchableOpacity onPress={hardResetAll} style={styles.backBtn}>
          <Text style={styles.backText}>‹ Back</Text>
        </TouchableOpacity>
        <View style={styles.overlayTop}>
          <Text style={styles.overlayText}>
            {livenessPassed ? (countdown > 0 ? `Ready • ${countdown}` : "Ready for capture") : "Blink to verify liveness"}
          </Text>
          {debugOpen && <Text style={styles.debugText}>Eye openness: {debugOpen}</Text>}
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

  // ---- Two-box main UI
  return (
    <View style={styles.mainContainer}>
      <Text style={styles.mainTitle}>Face Comparison</Text>

      <View style={styles.row}>
        {/* Selfie box */}
        <View style={styles.box}>
          <Text style={styles.label}>1. Capture Selfie</Text>
          {selfieUri ? (
            <Image source={{ uri: selfieUri }} style={styles.preview} />
          ) : (
            <Text style={styles.placeholder}>No image</Text>
          )}
          <TouchableOpacity onPress={askPermissionAndStart} style={styles.primaryBtn}>
            <Text style={styles.primaryText}>{selfieUri ? "Retake" : "Open Face Detector"}</Text>
          </TouchableOpacity>
        </View>

        {/* Gallery box */}
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

// ---------- Styles ----------
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
  primaryBtn: {
    backgroundColor: "#2563EB",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  primaryText: { color: "#fff", fontWeight: "600" },
  compareBtn: {
    backgroundColor: "#16A34A",
    marginTop: 24,
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: 12,
  },
  compareText: { color: "#fff", fontWeight: "800", fontSize: 16 },
  resultText: { marginTop: 14, fontWeight: "700", fontSize: 16 },

  // Camera view
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
