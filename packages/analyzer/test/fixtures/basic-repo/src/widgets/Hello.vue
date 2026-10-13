<template><p>{{ msg }}</p></template>
<script setup lang="ts">
import { formatDate } from '../lib/format';
const msg = formatDate(new Date());
</script>
