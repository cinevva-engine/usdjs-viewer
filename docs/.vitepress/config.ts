import { defineConfig } from 'vitepress'

export default defineConfig({
  title: '@cinevva/usdjs-viewer',
  description: 'Browser USD viewer built on Three.js',
  base: '/usdjs-viewer/',
  cleanUrls: true,
  lastUpdated: true,

  head: [
    ['meta', { name: 'theme-color', media: '(prefers-color-scheme: light)', content: '#8b5cf6' }],
    ['meta', { name: 'theme-color', media: '(prefers-color-scheme: dark)', content: '#070714' }],
  ],

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/' },
      {
        text: 'Ecosystem',
        items: [
          { text: 'usdjs (Core)', link: 'https://cinevva-engine.github.io/usdjs/' },
          { text: 'usdjs-viewer', link: 'https://cinevva-engine.github.io/usdjs-viewer/' },
          { text: 'usdjs-renderer', link: 'https://cinevva-engine.github.io/usdjs-renderer/' },
        ]
      }
    ],

    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Introduction', link: '/' },
          { text: 'Getting Started', link: '/getting-started' },
          { text: 'Integration', link: '/integration' },
        ]
      }
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/cinevva-engine/usdjs-viewer' }
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2024-present Cinevva'
    },

    editLink: {
      pattern: 'https://github.com/cinevva-engine/usdjs-viewer/edit/main/docs/:path',
      text: 'Edit this page on GitHub'
    }
  }
})
