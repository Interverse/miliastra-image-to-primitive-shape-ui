export function broadcast(name, message) {
  new BroadcastChannel(name).postMessage(message);
}