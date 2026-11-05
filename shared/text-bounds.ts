// Browser measurements are hints for layout, not authority over shape ownership.
const STYLE_KEYS = ['richText','text','size','font','fontSizeAdjustment','growY','w','h','scale','autoSize','align','verticalAlign','geo'] as const;
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key,v]) => [key,stable(v)]));
  return value;
}
export function textBoundsSignature(shape: { type: string; props?: Record<string, unknown> }): string {
  const props = shape.props ?? {};
  const source = JSON.stringify(stable({ type: shape.type, props: Object.fromEntries(STYLE_KEYS.filter(k => props[k] !== undefined).map(k => [k,props[k]])) }));
  let hash=0xcbf29ce484222325n;
  for(let i=0;i<source.length;i++) hash=BigInt.asUintN(64,(hash^BigInt(source.charCodeAt(i)))*0x100000001b3n);
  return `v1:${source.length}:${hash.toString(16).padStart(16,'0')}`;
}
export interface MeasuredTextBounds { version: 1; signature: string; w: number; h: number }
export function measuredTextBounds(shape: {type:string;props?:Record<string,unknown>;meta?:Record<string,unknown>}): {w:number;h:number}|null {
  if(!['note','geo','text'].includes(shape.type))return null;
  const m=shape.meta?.measuredTextBounds as MeasuredTextBounds|undefined;
  if(!m||m.version!==1||m.signature!==textBoundsSignature(shape))return null;
  if(!Number.isFinite(m.w)||!Number.isFinite(m.h)||m.w<=0||m.h<=0||m.w>100000||m.h>100000)return null;
  return {w:m.w,h:m.h};
}
