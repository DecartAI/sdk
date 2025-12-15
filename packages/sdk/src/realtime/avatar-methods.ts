import type { AvatarReadyMessage } from "./types";
import type { WebRTCManager } from "./webrtc-manager";

const AVATAR_SETUP_TIMEOUT_MS = 15 * 1000; // 15 seconds for avatar setup

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // Remove data URL prefix (e.g., "data:image/png;base64,")
      const base64 = result.split(",")[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export const avatarMethods = (webrtcManager: WebRTCManager) => {
  /**
   * Set the avatar image for animation.
   * Called automatically during connection setup.
   */
  const setAvatarImage = async (imageData: Blob): Promise<void> => {
    const emitter = webrtcManager.getWebsocketMessageEmitter();
    let avatarReadyListener: ((msg: AvatarReadyMessage) => void) | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      const imageBase64 = await blobToBase64(imageData);

      const readyPromise = new Promise<void>((resolve, reject) => {
        avatarReadyListener = (msg: AvatarReadyMessage) => {
          if (msg.success) {
            resolve();
          } else {
            reject(new Error(msg.error || "Failed to set avatar image"));
          }
        };
        emitter.on("avatarReady", avatarReadyListener);
      });

      webrtcManager.sendMessage({
        type: "set_avatar_image",
        image: imageBase64,
      });

      const timeoutPromise = new Promise<void>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("Avatar setup timed out")), AVATAR_SETUP_TIMEOUT_MS);
      });

      await Promise.race([readyPromise, timeoutPromise]);
    } finally {
      if (avatarReadyListener) {
        emitter.off("avatarReady", avatarReadyListener);
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  };

  return {
    setAvatarImage,
  };
};
