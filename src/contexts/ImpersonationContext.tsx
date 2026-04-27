import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

type ImpersonationState = {
  targetUserId: string | null
  targetCompanyName: string | null
}

type ImpersonationContextValue = {
  state: ImpersonationState
  impersonate: (next: { targetUserId: string; targetCompanyName: string }) => void
  clear: () => void
}

const KEY = 'zapifica_impersonation_v1'

const Ctx = createContext<ImpersonationContextValue | null>(null)

function safeParse(json: string): ImpersonationState | null {
  try {
    const o = JSON.parse(json) as Partial<ImpersonationState>
    const targetUserId =
      typeof o.targetUserId === 'string' && o.targetUserId.trim()
        ? o.targetUserId.trim()
        : null
    const targetCompanyName =
      typeof o.targetCompanyName === 'string' && o.targetCompanyName.trim()
        ? o.targetCompanyName.trim()
        : null
    if (!targetUserId) return null
    return { targetUserId, targetCompanyName }
  } catch {
    return null
  }
}

export function ImpersonationProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ImpersonationState>({
    targetUserId: null,
    targetCompanyName: null,
  })

  useEffect(() => {
    const raw = localStorage.getItem(KEY)
    if (!raw) return
    const parsed = safeParse(raw)
    if (parsed) setState(parsed)
  }, [])

  useEffect(() => {
    if (state.targetUserId) {
      localStorage.setItem(KEY, JSON.stringify(state))
    } else {
      localStorage.removeItem(KEY)
    }
  }, [state])

  const impersonate = useCallback(
    (next: { targetUserId: string; targetCompanyName: string }) => {
      setState({
        targetUserId: next.targetUserId,
        targetCompanyName: next.targetCompanyName,
      })
    },
    [],
  )

  const clear = useCallback(() => {
    setState({ targetUserId: null, targetCompanyName: null })
  }, [])

  const value = useMemo(
    () => ({ state, impersonate, clear }),
    [state, impersonate, clear],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useImpersonation() {
  const v = useContext(Ctx)
  if (!v) {
    throw new Error('useImpersonation deve ser usado dentro de ImpersonationProvider')
  }
  return v
}

