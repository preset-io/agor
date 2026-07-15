interface YouTubeEmbedProps {
  id: string;
  title: string;
}

// Privacy-enhanced (youtube-nocookie), lazy-loaded, responsive 16:9 embed.
export function YouTubeEmbed({ id, title }: YouTubeEmbedProps) {
  return (
    <div
      style={{
        position: 'relative',
        aspectRatio: '16 / 9',
        margin: '1.5rem 0',
        overflow: 'hidden',
        borderRadius: '12px',
        border: '1px solid rgba(52, 230, 196, 0.14)',
        background: '#081210',
      }}
    >
      <iframe
        src={`https://www.youtube-nocookie.com/embed/${id}`}
        title={title}
        loading="lazy"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
      />
    </div>
  );
}
