import { mkdir, writeFile } from 'fs/promises'
import { dirname, sep } from 'path'
import puppeteer, { HTTPRequest, Browser, Page } from 'puppeteer'
import { argv } from 'process'

const target = argv[2]
const maxRetry = 10

// const browser = await puppeteer.launch({ headless: false, slowMo: 500 })
const browser = await puppeteer.launch({ headless: 'new' })
const page = await browser.newPage()

// @ts-ignore https://github.com/puppeteer/puppeteer/issues/6647#issuecomment-1610949415
await page._client().send('Network.enable', {
  maxResourceBufferSize: 1024 * 1204 * 100,
  maxTotalBufferSize: 1024 * 1204 * 200,
})

interface Entry {
  path: string
  url: string
}

const folders: Entry[] = []
const files: Entry[] = []

function addItem(item: Item, prefix: string) {
  if (item.type === 'folder') {
    folders.push({ path: prefix + item.name, url: item.url })
  } else {
    files.push({ path: prefix + item.name, url: item.url })
  }
}

;(await scrapeFolder(target)).forEach((item) => addItem(item, ''))

while (folders.length > 0) {
  const { path, url } = folders.shift() ?? error()

  for (let retry = 1; retry <= maxRetry; retry++) {
    try {
      const items = await scrapeFolder(url)
      items.forEach((item) => addItem(item, path + sep))
      break
    } catch (e) {
      if (retry === maxRetry) throw e
      console.log(`retry ${retry} / ${maxRetry}`)
    }
  }
}

while (files.length > 0) {
  // TODO: Parallelize
  const { path, url } = files.shift() ?? error()
  const savePath = 'download' + sep + path

  for (let retry = 1; retry <= maxRetry; retry++) {
    try {
      const buffer = await scrapeFile(url)
      await mkdir(dirname(savePath), { recursive: true })
      await writeFile(savePath, buffer)
      break
    } catch (e) {
      if (retry === maxRetry) throw e
      console.log(`retry ${retry} / ${maxRetry}`)
    }
  }
}

await browser.close()

// #region utils

interface Item {
  type: 'folder' | 'file'
  name: string
  url: string
}

function error(e: string = 'error'): never {
  throw e
}

function withResolvers<T>() {
  let resolve: (value: T) => void
  let reject: (reason?: any) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve: resolve!, reject: reject! }
}

function timeout<T>(value: Promise<T>, ms: number): Promise<T> {
  const { promise, resolve, reject } = withResolvers<T>()
  value.then(resolve)
  setTimeout(() => reject(new Error('timeout')), ms)
  return promise
}

function typeFromUrl(url: string): Item['type'] {
  if (url.match(/\/file\/\d+$/)) return 'file'
  if (url.match(/\/folder\/\d+$/)) return 'folder'
  error('unknown type')
}

async function scrapeFolder(target: string): Promise<Item[]> {
  console.log('scraping', target)

  // TODO: Parse HTML directly without using playwright
  //       Box.postStreamData["/app-api/enduserapp/shared-folder"].items

  await page.goto(target)
  await page.waitForNetworkIdle()

  const toAbsolute = (url: string) => new URL(url, target).href

  const links = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.item-link'))
    return items.map((item) => ({
      text: item.textContent,
      href: item.getAttribute('href'),
    }))
  })

  const items = links.map((link) => {
    const name = link.text ?? error()
    const url = toAbsolute(link.href ?? error())
    const type = typeFromUrl(url)
    return { type, name, url }
  })

  return items
}

async function scrapeFile(target: string): Promise<Buffer> {
  console.log('scraping', target)

  const { promise, resolve } = withResolvers<Buffer>()

  async function onRequest(request: HTTPRequest) {
    const url = request.url()
    if (url.endsWith('/download')) {
      const response = request.response() ?? error("response doesn't exist")
      const buffer = await response.buffer()
      // console.log(`downloaded ${buffer.length} bytes`)
      resolve(buffer)
    }
  }

  try {
    page.on('requestfinished', onRequest)
    await page.goto(target)
    return await timeout(promise, 20000)
  } finally {
    page.off('requestfinished', onRequest)
  }
}

// #endregion
