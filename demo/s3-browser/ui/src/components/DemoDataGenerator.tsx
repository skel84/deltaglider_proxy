import { useEffect, useRef, useState } from 'react';
import { ExperimentOutlined, LoadingOutlined } from '@ant-design/icons';
import { uploadObject } from '../s3client';
import { useColors } from '../ThemeContext';

const MENU_ICON_STYLE: React.CSSProperties = { fontSize: 14, width: 22, textAlign: 'center', display: 'inline-flex', justifyContent: 'center' };

interface Props {
  onDone: () => void;
  variant?: 'inline' | 'empty-state';
  label?: string;
}

// CRC-32 (IEEE) — required by the ZIP format. Table built once.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Build a REAL, openable ZIP (single stored/uncompressed entry). Stored — not
// DEFLATE — on purpose: a tiny content change then yields a tiny binary delta,
// which is the whole point of the demo. A compressed entry would scramble end
// to end and defeat delta dedup.
function makeZip(entryName: string, content: string): Uint8Array {
  const enc = new TextEncoder();
  const name = enc.encode(entryName);
  const data = enc.encode(content);
  const crc = crc32(data);
  const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

  // Local file header + data
  const local = [
    ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
    ...u32(crc), ...u32(data.length), ...u32(data.length),
    ...u16(name.length), ...u16(0), ...name, ...data,
  ];
  // Central directory header
  const central = [
    ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
    ...u32(crc), ...u32(data.length), ...u32(data.length),
    ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(0), ...name,
  ];
  // End of central directory
  const eocd = [
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(1), ...u16(1),
    ...u32(central.length), ...u32(local.length), ...u16(0),
  ];
  return new Uint8Array([...local, ...central, ...eocd]);
}

// Versioned "release" zip. The payload is mostly stable across versions with a
// few lines changing — so delta compression dedups the shared bulk.
function makeReleaseZip(version: number): Uint8Array {
  const stable = Array.from({ length: 800 }, (_, i) => `config.entry.${i} = value-${i}`).join('\n');
  const changelog = `app v1.${version}.0\nbuilt: release ${version}\nfeature flag ${version} enabled\n`;
  return makeZip('release/manifest.txt', `${changelog}\n${stable}\n`);
}

export default function DemoDataGenerator({ onDone, variant = 'inline', label = 'Demo Data' }: Props) {
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState('');
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const generate = async () => {
    setGenerating(true);
    try {
      for (let v = 1; v <= 5; v++) {
        if (!mountedRef.current) return;
        setProgress(`Uploading version ${v}/5...`);
        const zip = makeReleaseZip(v);
        await uploadObject(
          `demo-releases/app-v${v}.zip`,
          zip.buffer as ArrayBuffer
        );
      }
      setProgress('Done!');
      onDone();
      window.setTimeout(() => {
        if (mountedRef.current) setProgress('');
      }, 2000);
    } catch (e) {
      if (mountedRef.current) setProgress('Error generating demo data');
      console.error(e);
    } finally {
      if (mountedRef.current) setGenerating(false);
    }
  };

  const { TEXT_PRIMARY, TEXT_SECONDARY, ACCENT_BLUE } = useColors();
  const isEmptyState = variant === 'empty-state';

  return (
    <div>
      <button
        className="btn-reset"
        onClick={generate}
        disabled={generating}
        style={{
          gap: isEmptyState ? 10 : 8,
          padding: isEmptyState ? '4px 8px' : '6px 6px',
          color: isEmptyState ? ACCENT_BLUE : TEXT_SECONDARY,
          fontSize: isEmptyState ? 13 : 11,
          fontWeight: isEmptyState ? 600 : 400,
          width: isEmptyState ? 'auto' : '100%',
          border: 'none',
          borderRadius: isEmptyState ? 8 : undefined,
          background: 'transparent',
          transition: 'color 0.15s',
          fontFamily: "var(--font-ui)",
          opacity: generating ? 0.6 : (isEmptyState ? 1 : 0.7),
        }}
        onMouseEnter={(e) => { if (!generating) e.currentTarget.style.color = TEXT_PRIMARY; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = isEmptyState ? ACCENT_BLUE : TEXT_SECONDARY; }}
      >
        {generating
          ? <LoadingOutlined aria-hidden="true" style={MENU_ICON_STYLE} />
          : <ExperimentOutlined aria-hidden="true" style={MENU_ICON_STYLE} />
        }
        <span>{progress || label}</span>
      </button>
    </div>
  );
}
