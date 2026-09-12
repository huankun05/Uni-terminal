/**
 * 语音输入（Web Speech API）。
 *
 * SpeechRecognition 和摄像头一样是安全上下文 API：HTTPS 或 localhost 下才
 * 存在。明文 HTTP 局域网上不可用——此时按钮给出如实提示，并指出输入法
 * 自带的语音键始终可用（它在系统层工作，不经网页）。
 */

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): SpeechRecognitionCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export function speechSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(recognitionCtor() && window.isSecureContext);
}

/**
 * 开始听写；返回停止句柄。识别到的最终文本通过 onText 逐段回调，
 * 由调用方决定追加到哪里。再次调用前先 stop() 上一段。
 */
export function startVoice(
  onText: (text: string) => void,
  onEnd?: () => void,
  lang = 'zh-CN',
): { stop: () => void } | null {
  const Ctor = recognitionCtor();
  if (!Ctor) return null;

  const rec = new Ctor();
  rec.lang = lang;
  rec.interimResults = false;
  rec.continuous = true;

  rec.onresult = (event) => {
    let text = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      text += event.results[i]?.[0]?.transcript ?? '';
    }
    if (text.trim()) onText(text.trim());
  };
  rec.onerror = (event) => {
    console.warn('[speech] error:', event.error);
  };
  rec.onend = () => onEnd?.();

  try {
    rec.start();
  } catch {
    return null;
  }
  return {
    stop: () => {
      try {
        rec.stop();
      } catch {
        // Already stopped.
      }
    },
  };
}
