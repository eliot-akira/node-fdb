import * as fdb from './native'
import Transaction from './transaction'
import {Value} from './native'
import {KeySelector} from './keySelector'
import FDBError from './error'

import {eachOption} from './opts'
import {DatabaseOptions, TransactionOptions, databaseOptionData} from './opts.g'


export default class Database {
  _db: fdb.NativeDatabase

  constructor(db: fdb.NativeDatabase, opts?: DatabaseOptions) {
    this._db = db
    if (opts) eachOption(databaseOptionData, opts, (code, val) => db.setOption(code, val))
  }

  // This is the API you want to use for non-trivial transactions.
  async doTransaction<T>(body: (tn: Transaction) => Promise<T>, opts?: TransactionOptions): Promise<T> {
    const tn = this.rawCreateTransaction(opts)

    // Logic described here:
    // https://apple.github.io/foundationdb/api-c.html#c.fdb_transaction_on_error
    do {
      try {
        const result: T = await body(tn)
        await tn.rawCommit()
        return result // Ok, success.
      } catch (err) {
        // See if we can retry the transaction
        if (err instanceof FDBError) {
          await tn.rawOnError(err.code) // If this throws, punt error to caller.
          // If that passed, loop.
        } else throw err
      }
    } while (true)
  }

  doOneshot(body: (tn: Transaction) => void, opts?: TransactionOptions): Promise<void> {
    // TODO: Could this be written better? It doesn't need a retry loop.
    return this.doTransaction(tn => {
      body(tn)
      return Promise.resolve()
    })
  }

  // This is for advanced usage only. You probably don't want to create
  // transactions manually. Use doTransaction instead.
  rawCreateTransaction(opts?: TransactionOptions) {
    return new Transaction(this._db.createTransaction(), false, opts)
  }


  get(key: Value): Promise<Buffer | null> {
    return this.doTransaction(tn => tn.snapshot().get(key))
  }
  getKey(selector: KeySelector): Promise<Value> {
    return this.doTransaction(tn => tn.snapshot().getKey(selector))
  }

  set(key: Value, value: Value) {
    return this.doOneshot(tn => tn.set(key, value))
  }

  clear(key: Value) {
    return this.doOneshot(tn => tn.clear(key))
  }

  clearRange(start: Value, end: Value) {
    return this.doOneshot(tn => tn.clearRange(start, end))
  }

  clearRangeStartsWith(prefix: Value) {
    return this.doOneshot(tn => tn.clearRangeStartsWith(prefix))
  }

  getAndWatch(key: Value, listener: fdb.Callback<void>): Promise<fdb.Watch & {value: Buffer | null}> {
    return this.doTransaction(async tn => {
      const value = await tn.get(key)
      const watch = tn.watch(key, listener) as any
      watch.value = value
      return watch
    })
  }

  // TODO: What happens if this set conflicts? Does the watch promise fire to be aborted?
  setAndWatch(key: Value, value: Value, listener: fdb.Callback<void>): Promise<fdb.Watch> {
    return this.doTransaction(async tn => {
      tn.set(key, value)
      return tn.watch(key, listener)
    })
  }

  clearAndWatch(key: Value, listener: fdb.Callback<void>): Promise<fdb.Watch> {
    return this.doTransaction(async tn => {
      tn.clear(key)
      return tn.watch(key, listener)
    })
  }

  getRangeAll(
      start: string | Buffer | KeySelector,
      end: string | Buffer | KeySelector,
      opts?: {
        limit?: number,
        targetBytes?: number,
        reverse?: boolean
      }) {
    return this.doTransaction(async tn => tn.snapshot().getRangeAll(start, end, opts))
  }
}
