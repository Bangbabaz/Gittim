<script setup lang="ts">
import { ref, onMounted } from 'vue'
import TerminalView from './components/Terminal.vue'

const cwd = ref<string | null>(null)

onMounted(async () => {
  cwd.value = await window.api.getCwd()
})
</script>

<template>
  <TerminalView v-if="cwd !== null" :cwd="cwd" />
</template>

<style>
body {
  margin: 0;
  padding: 0;
  overflow: hidden;
}
</style>
