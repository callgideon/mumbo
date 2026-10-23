import type { IconProps } from './icons/props.ts'

/** Native viewBox of {@link FISH_LOGO_PATH} (width and height in user units). */
export const FISH_LOGO_VIEWBOX = { width: 763, height: 476 }

/** The mumbo 'm' mark path data, exported for consumers that compose their own svg around the same geometry. */
export const FISH_LOGO_PATH = 'M70 414V129Q70 92 55 78Q40 65 0 63L3 34Q39 27 94 10Q100 8 126 0L144 9L151 61Q168 42 198 21Q229 0 273 0Q365 0 405 62Q436 34 468 17Q500 0 538 0Q606 0 650 36Q693 73 693 150V414Q703 422 722 430Q742 438 763 442L759 476H540L542 442Q580 436 608 414V147Q608 96 588 72Q569 48 529 48Q497 48 469 68Q441 88 427 115V414Q436 422 456 430Q476 438 497 442L493 476H273L276 442Q314 436 342 414V147Q342 96 322 72Q303 48 263 48Q228 48 197 72Q166 97 156 126V414Q179 432 225 442L221 476H0L4 440Q28 436 42 431Q56 426 70 414Z'

/**
 * Render the mumbo mark.
 * @param props.size - width in px (default 24; height keeps the mark's ratio).
 * @param props.className - extra class for layout placement.
 * @returns the mark svg (aria-hidden; pair with the wordmark for accessibility).
 */
export function FishLogo({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={(size * FISH_LOGO_VIEWBOX.height) / FISH_LOGO_VIEWBOX.width}
      className={className}
      viewBox={`0 0 ${FISH_LOGO_VIEWBOX.width} ${FISH_LOGO_VIEWBOX.height}`}
      fill="none"
      aria-hidden="true"
    >
      <path d={FISH_LOGO_PATH} fill="currentColor" />
    </svg>
  )
}
