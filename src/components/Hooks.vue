<script setup lang="ts">
import useStore from '../store'

const store = useStore()
store.msg = useMessage()
store.loadingBar = useLoadingBar()
</script>

<template>
</template>
