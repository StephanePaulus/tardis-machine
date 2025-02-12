import qs from 'querystring'
import { combine, compute, Exchange, streamNormalized } from 'tardis-dev'
import { HttpRequest, WebSocket } from 'uWebSockets.js'
import { debug } from '../debug'
import { constructDataTypeFilter, getComputables, getNormalizers, StreamNormalizedRequestOptions, wait } from '../helpers'

export async function streamNormalizedWS(ws: WebSocket, req: HttpRequest) {
  let messages: AsyncIterableIterator<any> | undefined

  try {
    const startTimestamp = new Date().getTime()
    const parsedQuery = qs.decode(req.getQuery())
    const optionsString = parsedQuery['options'] as string
    const streamNormalizedOptions = JSON.parse(optionsString) as StreamNormalizedRequestOptions

    debug('WebSocket /ws-stream-normalized started, options: %o', streamNormalizedOptions)

    const options = Array.isArray(streamNormalizedOptions) ? streamNormalizedOptions : [streamNormalizedOptions]
    let subSequentErrorsCount: { [key in Exchange]?: number } = {}

    let retries = 0
    let bufferedAmount = 0

    const messagesIterables = options.map((option) => {
      // let's map from provided options to options and normalizers that needs to be added for dataTypes provided in options
      const messages = streamNormalized(
        {
          ...option,
          withDisconnectMessages: true,
          onError: (error) => {
            const exchange = option.exchange as Exchange
            if (subSequentErrorsCount[exchange] === undefined) {
              subSequentErrorsCount[exchange] = 0
            }

            subSequentErrorsCount[exchange]!++

            if (option.withErrorMessages && !ws.closed) {
              ws.send(
                JSON.stringify({
                  type: 'error',
                  exchange,
                  localTimestamp: new Date(),
                  details: error.message
                })
              )
            }

            debug('WebSocket /ws-stream-normalized %s WS connection error: %o', exchange, error)
          }
        },
        ...getNormalizers(option.dataTypes)
      )
      // separately check if any computables are needed for given dataTypes
      const computables = getComputables(option.dataTypes)

      if (computables.length > 0) {
        return compute(messages, ...computables)
      }

      return messages
    })

    const filterByDataType = constructDataTypeFilter(options)
    messages = messagesIterables.length === 1 ? messagesIterables[0] : combine(...messagesIterables)

    for await (const message of messages) {
      if (ws.closed) {
        return
      }

      const exchange = message.exchange as Exchange

      if (subSequentErrorsCount[exchange] !== undefined && subSequentErrorsCount[exchange]! >= 50) {
        ws.end(1011, `Too many subsequent errors when connecting to  ${exchange} WS API`)
        return
      }

      if (!filterByDataType(message)) {
        continue
      }

      retries = 0
      bufferedAmount = 0
      // handle backpressure in case of slow clients
      while ((bufferedAmount = ws.getBufferedAmount()) > 0) {
        retries += 1
        await wait(10 * retries)

        if (retries % 20 === 0 || retries === 5) {
          debug('Slow client, waiting %d ms, buffered amount: %d', 10 * retries, bufferedAmount)
        }
        if (retries > 100) {
          ws.end(1008, 'Too much backpressure')
          return
        }
      }

      ws.send(JSON.stringify(message))

      if (message.type !== 'disconnect') {
        subSequentErrorsCount[exchange] = 0
      }
    }

    while (ws.getBufferedAmount() > 0) {
      await wait(100)
    }

    ws.end(1000, 'WS stream-normalized finished')

    const endTimestamp = new Date().getTime()

    debug(
      'WebSocket /ws-stream-normalized finished, options: %o, time: %d seconds',
      streamNormalizedOptions,
      (endTimestamp - startTimestamp) / 1000
    )
  } catch (e: any) {
    if (!ws.closed) {
      ws.end(1011, e.toString())
    }

    debug('WebSocket /ws-stream-normalized  error: %o', e)
    console.error('WebSocket /ws-stream-normalized error:', e)
  } finally {
    // this will close underlying open WS connections
    if (messages !== undefined) {
      messages!.return!()
    }
  }
}
