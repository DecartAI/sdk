# Realtime module layout

- `browser/` contains browser-only connection setup, frame transforms, pixel diagnostics, and deep preflight.
- `react-native/` contains React Native setup validation, supported-feature policy, and native preflight.
- Files directly under `realtime/` and `observability/` are shared by both platforms.

`src/index.ts` and `src/index.react-native.ts` select one platform factory through package export conditions. Both factories return the same three operations: `connect`, `subscribe`, and `checkConnectivity`.

Keep DOM and browser frame-processing imports inside `browser/`. Keep React Native setup policy inside `react-native/`.
