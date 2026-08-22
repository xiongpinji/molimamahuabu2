import { build } from 'vite'

process.env.VITE_PUBLIC_PLATFORM_MODE = 'true'
await build()
