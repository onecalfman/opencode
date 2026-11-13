import "./command-progress.css"

export function CommandProgress() {
  return (
    <svg data-component="command-progress" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="m2.5 4 4 4-4 4"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path class="command-cursor" d="M9 11.5h4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    </svg>
  )
}
