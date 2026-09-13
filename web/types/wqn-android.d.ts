interface WQNAndroidBridge {
  /** Native print; returns true when the native side took over. */
  print?: (title?: string) => boolean;
  /** Note: the native bridge matches by arity - always pass a message. */
  onClientError?: (message: string) => void;
  openSettings?: () => void;
}

interface Window {
  WQNAndroid?: WQNAndroidBridge;
}
