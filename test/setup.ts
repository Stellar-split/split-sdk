/**
 * Vitest setup file
 * Configures testing environment for React components
 */

import '@testing-library/jest-dom';

// Mock EventSource for SSE tests
global.EventSource = class EventSource {
  constructor(public url: string) {}
  onopen: ((this: EventSource, ev: Event) => any) | null = null;
  onmessage: ((this: EventSource, ev: MessageEvent) => any) | null = null;
  onerror: ((this: EventSource, ev: Event) => any) | null = null;
  close() {}
  addEventListener() {}
  removeEventListener() {}
  dispatchEvent(): boolean {
    return true;
  }
} as any;

// Mock window.crypto if not available
if (typeof window !== 'undefined' && !window.crypto) {
  Object.defineProperty(window, 'crypto', {
    value: {
      getRandomValues: (arr: any) => {
        for (let i = 0; i < arr.length; i++) {
          arr[i] = Math.floor(Math.random() * 256);
        }
        return arr;
      },
    },
  });
}
