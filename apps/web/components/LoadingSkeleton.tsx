export function EndpointSkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3].map((i) => (
        <div key={i} className="rounded-2xl border p-4 md:p-5 animate-pulse" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.06)' }}>
          <div className="flex items-start justify-between gap-3 mb-3">
            <div className="flex items-center gap-2">
              <div className="h-4 w-32 rounded-lg" style={{ background: 'rgba(255,255,255,0.06)' }} />
              <div className="h-4 w-12 rounded-full" style={{ background: 'rgba(255,255,255,0.04)' }} />
            </div>
            <div className="h-4 w-20 rounded-lg" style={{ background: 'rgba(255,255,255,0.04)' }} />
          </div>
          <div className="h-8 w-full rounded-lg" style={{ background: 'rgba(255,255,255,0.04)' }} />
        </div>
      ))}
    </div>
  )
}

export function EventSkeleton() {
  return (
    <div className="space-y-2">
      {[1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="rounded-xl p-3 md:p-4 animate-pulse border" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.06)' }}>
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              <div className="h-3 w-10 rounded" style={{ background: 'rgba(255,255,255,0.06)' }} />
              <div className="h-3 w-16 rounded-full" style={{ background: 'rgba(255,255,255,0.04)' }} />
            </div>
            <div className="h-3 w-14 rounded" style={{ background: 'rgba(255,255,255,0.04)' }} />
          </div>
          <div className="h-3 w-3/4 rounded mt-1" style={{ background: 'rgba(255,255,255,0.04)' }} />
        </div>
      ))}
    </div>
  )
}
