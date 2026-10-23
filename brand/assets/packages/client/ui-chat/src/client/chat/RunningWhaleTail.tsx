/** Animated mumbo mark mask and static SVG fallback for the running Chat status. */
import css from './ChatView.module.css'

const REST_PATH = 'M70 414V129Q70 92 55 78Q40 65 0 63L3 34Q39 27 94 10Q100 8 126 0L144 9L151 61Q168 42 198 21Q229 0 273 0Q365 0 405 62Q436 34 468 17Q500 0 538 0Q606 0 650 36Q693 73 693 150V414Q703 422 722 430Q742 438 763 442L759 476H540L542 442Q580 436 608 414V147Q608 96 588 72Q569 48 529 48Q497 48 469 68Q441 88 427 115V414Q436 422 456 430Q476 438 497 442L493 476H273L276 442Q314 436 342 414V147Q342 96 322 72Q303 48 263 48Q228 48 197 72Q166 97 156 126V414Q179 432 225 442L221 476H0L4 440Q28 436 42 431Q56 426 70 414Z'

/**
 * Render the decorative running icon; the APNG asset owns its animation timing.
 * @returns mask and static SVG selected by browser capabilities and accessibility preferences.
 */
export function RunningWhaleTail() {
  return (
    <span className={css.runningIcon} aria-hidden="true">
      <span className={css.runningWhaleAnimated} />
      <svg className={css.runningWhaleStill} width="100%" height="100%" viewBox="-92 -236 947 947" fill="none">
        <path d={REST_PATH} fill="currentColor" />
      </svg>
    </span>
  )
}
