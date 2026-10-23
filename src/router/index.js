import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/weather',
      name: 'Weather',
      alias: ['/', '/weather'],
      component: () => import('../views/WeatherView.vue')
    }
  ]
})

export default router
