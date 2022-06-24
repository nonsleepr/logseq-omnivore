import '@logseq/libs'
import {
  BlockEntity,
  LSPluginBaseInfo,
  SettingSchemaDesc,
} from '@logseq/libs/dist/LSPlugin'
import * as icon from './icon.png'

interface GetArticleResponse {
  data: {
    article: {
      article: Article
    }
  }
}

interface SearchResponse {
  data: {
    search: {
      edges: { node: Article }[]
      pageInfo: {
        hasNextPage: boolean
      }
    }
  }
}

interface Article {
  title: string
  author: string
  description: string
  slug: string
  labels: Label[]
  highlights: Highlight[]
  updatedAt: string
  savedAt: string
}

interface Label {
  name: string
}

interface Highlight {
  quote: string
}

const settings: SettingSchemaDesc[] = [
  {
    key: 'api key',
    type: 'string',
    title: 'Enter Omnivore Api Key',
    description: 'Enter Omnivore Api Key here',
    default: '',
  },
  {
    key: 'username',
    type: 'string',
    title: 'Enter Omnivore username',
    description: 'Enter Omnivore username here',
    default: '',
  },
  {
    key: 'frequency',
    type: 'number',
    title: 'Enter sync with Omnivore frequency',
    description: 'Enter sync with Omnivore frequency in minutes here',
    default: 60,
  },
]
const endpoint = 'https://api-prod.omnivore.app/api/graphql'
const delay = (t = 100) => new Promise((r) => setTimeout(r, t))
let loading = false

const loadArticle = async (
  username: string,
  slug: string,
  apiKey: string
): Promise<Article> => {
  const res = await fetch(endpoint, {
    headers: {
      'content-type': 'application/json',
      authorization: apiKey,
    },
    body: `{"query":"\\n  query GetArticle(\\n    $username: String!\\n    $slug: String!\\n  ) {\\n    article(username: $username, slug: $slug) {\\n      ... on ArticleSuccess {\\n        article {\\n          ...ArticleFields\\n          highlights {\\n            ...HighlightFields\\n          }\\n          labels {\\n            ...LabelFields\\n          }\\n        }\\n      }\\n      ... on ArticleError {\\n        errorCodes\\n      }\\n    }\\n  }\\n  \\n  fragment ArticleFields on Article {\\n    savedAt\\n  }\\n\\n  \\n  fragment HighlightFields on Highlight {\\n    quote\\n  }\\n\\n  \\n  fragment LabelFields on Label {\\n    name\\n  }\\n\\n","variables":{"username":"${username}","slug":"${slug}"}}`,
    method: 'POST',
  })
  const response = (await res.json()) as GetArticleResponse

  return response.data.article.article
}

const loadArticles = async (
  apiKey: string,
  after = 0,
  first = 10,
  savedAfter = ''
): Promise<[Article[], boolean]> => {
  const res = await fetch(endpoint, {
    headers: {
      'content-type': 'application/json',
      authorization: apiKey,
    },
    body: `{"query":"\\n    query Search($after: String, $first: Int, $query: String) {\\n      search(first: $first, after: $after, query: $query) {\\n        ... on SearchSuccess {\\n          edges {\\n            node {\\n              title\\n              slug\\n              url\\n              author\\n              updatedAt\\n              description\\n            }\\n          }\\n          pageInfo {\\n            hasNextPage\\n          }\\n        }\\n        ... on SearchError {\\n          errorCodes\\n        }\\n      }\\n    }\\n  ","variables":{"after":"${after}","first":${first}, "query":"sort:saved-asc"}}`,
    method: 'POST',
  })

  const jsonRes = (await res.json()) as SearchResponse
  const articles = jsonRes.data.search.edges
    .map((e) => e.node)
    .filter((article) =>
      savedAfter ? new Date(article.updatedAt) > new Date(savedAfter) : true
    )

  return [articles, jsonRes.data.search.pageInfo.hasNextPage]
}

const loadOmnivore = async (
  apiKey: string,
  username: string
): Promise<void> => {
  if (loading) return

  if (!apiKey || !username) {
    await logseq.UI.showMsg('Missing Omnivore username or api key', 'warning')

    return
  }

  const pageName = 'Omnivore'
  const blockTitle = '## 🔖 Articles'
  const highlightTitle = '### 🔍 [[Highlights]]'
  const fetchingTitle = '🚀 Fetching articles ...'

  logseq.App.pushState('page', { name: pageName })

  await delay(300)

  loading = true
  let targetBlock: BlockEntity | null = null
  let lastSavedAt = ''

  try {
    await logseq.UI.showMsg('🚀 Fetching articles ...')

    const currentPage = await logseq.Editor.getCurrentPage()
    if (currentPage?.originalName !== pageName) throw new Error('page error')

    const pageBlocksTree = await logseq.Editor.getCurrentPageBlocksTree()
    targetBlock = pageBlocksTree.length > 0 ? pageBlocksTree[0] : null
    let lastUpdateAt = ''
    if (targetBlock) {
      const matches = targetBlock.content.match(
        /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}).(\d{3})Z/g
      )
      if (matches) {
        lastUpdateAt = matches[0]
      } else {
        lastUpdateAt = logseq.settings?.['synced at'] as string
      }
      lastSavedAt = lastUpdateAt
      await logseq.Editor.updateBlock(targetBlock.uuid, fetchingTitle)
    } else {
      targetBlock = await logseq.Editor.appendBlockInPage(
        currentPage.uuid,
        fetchingTitle
      )
    }
    if (!targetBlock) {
      throw new Error('block error')
    }

    const size = 100
    let after = 0
    /*eslint no-constant-condition: ["error", { "checkLoops": false }]*/
    while (true) {
      const [articles, hasNextPage] = await loadArticles(
        apiKey,
        after,
        size,
        lastUpdateAt
      )

      for (const { title, author, slug, description } of articles) {
        const { labels, highlights, savedAt } = await loadArticle(
          username,
          slug,
          apiKey
        )

        const content = `[${title}](https://omnivore.app/${username}/${slug})
        collapsed:: true
        author:: "${author}"
        labels:: ${
          labels
            ? labels.map((l: { name: string }) => `[[${l.name}]]`).join(' ')
            : 'null'
        }
        date:: ${new Date(savedAt).toDateString()}
        > ${description}`

        const articleBlock = await logseq.Editor.insertBlock(
          targetBlock.uuid,
          content,
          { before: true, sibling: false }
        )
        if (!articleBlock) {
          throw new Error('block error')
        }
        lastSavedAt = savedAt

        if (highlights?.length) {
          const highlightBlock = await logseq.Editor.insertBlock(
            articleBlock.uuid,
            highlightTitle
          )
          if (!highlightBlock) {
            throw new Error('block error')
          }

          for (const highlight of highlights) {
            await logseq.Editor.insertBlock(
              highlightBlock.uuid,
              highlight.quote
            )
          }
        }

        // sleep for a second to avoid rate limit
        await delay(1000)
      }

      if (!hasNextPage) {
        break
      }
      after += size
    }

    await logseq.UI.showMsg('🔖 Articles fetched')
  } catch (e) {
    await logseq.UI.showMsg('Failed to fetch articles', 'warning')
    console.error(e)
  } finally {
    loading = false
    if (targetBlock) {
      await logseq.Editor.updateBlock(
        targetBlock.uuid,
        `${blockTitle} [:small.opacity-20 "fetched at ${new Date().toISOString()}"]`
      )

      logseq.updateSettings({ 'synced at': lastSavedAt })
    }
  }
}

/**
 * main entry
 * @param baseInfo
 */
const main = async (baseInfo: LSPluginBaseInfo): Promise<void> => {
  console.log('logseq-omnivore loaded')

  logseq.useSettingsSchema(settings)

  const frequency = (logseq.settings?.frequency as number) || 60
  let apiKey = logseq.settings?.['api key'] as string
  let username = logseq.settings?.['username'] as string

  logseq.onSettingsChanged(() => {
    apiKey = logseq.settings?.['api key'] as string
    username = logseq.settings?.['username'] as string
  })

  logseq.provideModel({
    async loadOmnivore() {
      await loadOmnivore(apiKey, username)
    },
  })

  logseq.App.registerUIItem('toolbar', {
    key: 'logseq-omnivore',
    template: `
      <a data-on-click="loadOmnivore" class="button" style="width:3rem;height:3rem;">
        <img src="${icon as string}">
      </a>
    `,
  })

  logseq.provideStyle(`
    [data-injected-ui=logseq-omnivore-${baseInfo.id}] {
      display: flex;
      align-items: center;
    }
  `)

  // fetch articles on startup
  await loadOmnivore(apiKey, username)

  // fetch articles every minute
  setInterval(async () => {
    await loadOmnivore(apiKey, username)
  }, frequency * 1000 * 60)
}

// bootstrap
logseq.ready(main).catch(console.error)
