import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { IdeInfo } from '@shared/types'

const ides = ref<IdeInfo[]>([])
const loading = ref(false)
const defaultIdeId = ref<string | null>(null)
let initPromise: Promise<void> | null = null

async function load(force = false): Promise<IdeInfo[]> {
  loading.value = true
  try {
    const list = await window.api.ideList(force)
    ides.value = list
    return list
  } finally {
    loading.value = false
  }
}

function init(): Promise<void> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    const [settings] = await Promise.all([window.api.settingsGet(), load(false)])
    defaultIdeId.value = typeof settings.defaultIde === 'string' ? settings.defaultIde : null
  })()
  return initPromise
}

function setDefault(id: string): void {
  if (defaultIdeId.value === id) return
  defaultIdeId.value = id
  window.api.settingsSet({ defaultIde: id })
}

const defaultIde = computed<IdeInfo | null>(() => {
  if (!ides.value.length) return null
  return ides.value.find((item) => item.id === defaultIdeId.value) ?? ides.value[0]
})

export function useIdes(): {
  ides: Ref<IdeInfo[]>
  loading: Ref<boolean>
  defaultIdeId: Ref<string | null>
  defaultIde: ComputedRef<IdeInfo | null>
  init: () => Promise<void>
  load: (force?: boolean) => Promise<IdeInfo[]>
  setDefault: (id: string) => void
} {
  return { ides, loading, defaultIdeId, defaultIde, init, load, setDefault }
}
