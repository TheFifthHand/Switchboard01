// TEMPORARY development stand-ins until the real CablePanel / SamplerEditor exist. Deleted before hand-off.
export function CablePanel(props: { trackId: string; height?: number }) {
  return (
    <div style={{ height: '100%', border: '1px dashed #aaa', borderRadius: 8, display: 'grid', placeItems: 'center', color: '#888' }}>
      cable panel stand-in ({props.trackId}, {props.height}px)
    </div>
  );
}
export function SamplerEditor(props: { trackId: string }) {
  return <div style={{ height: 300, border: '1px dashed #aaa', borderRadius: 8, display: 'grid', placeItems: 'center', color: '#888' }}>sampler editor stand-in ({props.trackId})</div>;
}
