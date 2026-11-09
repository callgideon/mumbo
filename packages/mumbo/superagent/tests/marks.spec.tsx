import { expect, it } from 'vitest'
import { en } from '../src/client/locales.ts'
import { decisionMark, reportDot, sourceMark, threadMark, ticketMark } from '../src/client/marks.ts'
import { translator } from './fixtures/panel.tsx'

const t = translator(en)

it('marks each Ticket stage by whom it waits for, and an ended Ticket by its outcome', () => {
  const marks = [{ stage: 'person', action: 'answer' }, { stage: 'person', action: 'review' }, { stage: 'person', action: 'blocked' },
    { stage: 'person', action: 'failed' }, { stage: 'person', action: 'delivery' }, { stage: 'working', action: 'queued' },
    { stage: 'working' }, { stage: 'idle' }] as const
  expect(marks.map(stage => { const { label, tone, dot, icon } = ticketMark(t, { ...stage, ended: undefined }); return [label, tone, dot,
    icon] })).toEqual([
    ['Awaiting answer', 'warning', 'warning', 'ask'], ['Awaiting review', 'warning', 'warning', 'review'], ['Blocked', 'warning', 'warning', 'blocked'],
    ['Failed', 'danger', 'error', 'alert'], ['Input undelivered', 'warning', 'warning', 'inbox'], ['Queued', 'neutral', 'idle', 'queue'],
    ['Working', 'info', 'ongoing', 'running'], ['Waiting for a Trigger', 'neutral', 'idle', 'clock']])
  const ended = (['completed', 'merged', 'closed', 'dropped', 'stopped'] as const).map(outcome => ticketMark(t, { stage: 'ended',
    ended: { at: '', by: outcome === 'stopped' ? 'human' : 'executor', outcome } }))
  expect(ended.map(mark => mark.label)).toEqual(['Completed', 'Pull request merged', 'Pull request closed unmerged', 'Nothing to do', 'Stopped by a person'])
  expect(new Set(ended.map(({ tone, dot, icon }) => `${tone} ${dot} ${icon}`))).toEqual(new Set(['neutral idle stop']))
  expect(['failed', 'blocked', 'waiting', 'ready', 'progress', undefined].map(reportDot)).toEqual(['error', 'warning', 'warning', 'done',
    'ongoing', 'ongoing'])
})

it('marks each Thread stage, Source state and Decision outcome', () => {
  const threads = (['error', 'evaluating', 'queued', 'subscribed', 'dormant', 'unsubscribed'] as const).map(stage => threadMark(t,
    { stage, pending: 2 }))
  expect(threads.map(({ label, dot, icon }) => [label, dot, icon])).toEqual([['Polling failed', 'error', 'alert'], ['Eval running', 'ongoing', 'running'],
    ['2 queued', 'warning', 'queue'], ['Subscribed', 'done', 'inbox'], ['Tickets ended', 'idle', 'clock'], ['Not subscribed', 'idle', 'hash']])
  const sources = (['missing', 'off', 'error', 'setup', 'starting', 'paused', 'ready'] as const).map(state => sourceMark(t, state))
  expect(sources.map(({ label, dot }) => [label, dot])).toEqual([['Plugin not installed', 'idle'], ['Off', 'idle'], ['Failing', 'error'],
    ['Waiting for the deployment check', 'idle'], ['Starting', 'ongoing'], ['Pending', 'warning'], ['Running', 'done']])
  const decisions = (['accept', 'reopen', 'stop', 'ignore', 'unavailable', 'wouldAccept'] as const).map(outcome => decisionMark(t, outcome))
  expect(decisions.map(({ label, tone, dot, icon }) => [label, tone, dot, icon])).toEqual([['Accept', 'success', 'done', 'decision'],
    ['Reopen', 'success', 'done', 'refresh'], ['Stop', 'danger', 'idle', 'stop'], ['Ignore', 'neutral', 'idle', 'dismiss'],
    ['Unavailable', 'warning', 'warning', 'alert'], ['Ignore (would accept; observe only)', 'warning', 'idle', 'dismiss']])
})
