import React, { useRef, useEffect, useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Toast from 'react-native-toast-message';

import { useCameraDevice, useCameraPermission } from 'react-native-vision-camera';
import { Camera as FaceCamera } from 'react-native-vision-camera-face-detector';

export default function App() {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('front');
  const cameraRef = useRef(null);

  const [faces, setFaces] = useState([]);
  const [photo, setPhoto] = useState('');

  useEffect(() => {
    (async () => {
      if (!hasPermission) {
        const ok = await requestPermission();
        if (!ok) {
          Toast.show({ type: 'error', text1: 'Camera permission is required' });
        }
      }
    })();
  }, [hasPermission, requestPermission]);

  // Tweak these later if needed; empty {} also works with sensible defaults.
  const faceDetectionOptions = {
    performanceMode: 'fast',
    classificationMode: 'none',
    contourMode: 'none',
    landmarkMode: 'none',
    trackingEnabled: false,
  };

  const onFaces = (detected, _frame) => {
    setFaces(Array.isArray(detected) ? detected : []);
  };

  const takeShot = async () => {
    if (!cameraRef.current) return;
    if (!faces.length) {
      Toast.show({ type: 'info', text1: 'Please put your face in frame' });
      return;
    }
    const shot = await cameraRef.current.takePhoto({});
    setPhoto(`file://${shot.path}`);
  };

  if (!device || !hasPermission) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
        <Text style={{ color: '#888', marginTop: 8 }}>
          {device ? 'Waiting for permission…' : 'No camera device found'}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {photo ? (
        <Image source={{ uri: photo }} style={{ flex: 1, borderRadius: 10 }} />
      ) : (
        <View style={{ flex: 1, borderRadius: 10 }}>
          <FaceCamera
            ref={cameraRef}
            style={styles.camera}
            device={device}
            isActive={true}
            photo={true}                      // needed for takePhoto()
            faceDetectionCallback={onFaces}   // new plugin callback
            faceDetectionOptions={faceDetectionOptions}
          />
          <View style={styles.overlay}>
            <Text style={styles.overlayText}>Faces detected: {faces.length}</Text>
          </View>
          <View style={styles.bottomBar}>
            <TouchableOpacity onPress={takeShot} style={styles.shutterButton} />
          </View>
        </View>
      )}
      <Toast />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
  camera: { flex: 1, borderRadius: 10 },
  bottomBar: { position: 'absolute', bottom: 32, width: '100%', justifyContent: 'center', alignItems: 'center' },
  shutterButton: { width: 70, height: 70, borderRadius: 35, backgroundColor: '#fff' },
  overlay: { position: 'absolute', top: 20, alignSelf: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.5)' },
  overlayText: { color: '#fff', fontWeight: '600' },
});
