export interface Anime {
  id: string
  title: string
  cover: string
  description?: string
  released?: string
  score?: number
}

export interface Manga {
  id: string
  title: string
  cover: string
  description?: string
}

export interface NewsItem {
  id: string
  title: string
  summary?: string
  source?: string
  publishedAt?: string
}

export interface ToolConfig {
  id: string
  name: string
  icon?: string
  description?: string
}
