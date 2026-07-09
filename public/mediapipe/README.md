# MediaPipe assets

The wasm files in `wasm/` are copied from `node_modules/@mediapipe/tasks-vision/wasm`
by `npm run copy:mediapipe`.

Hand tracking also needs the same-origin model file:

```
public/mediapipe/hand_landmarker.task
```

Download the float16 Hand Landmarker model from:

https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task

If the file is absent, AUTOTOAD runs normally and shows:

"Hand tracking model missing — see public/mediapipe/README"
