function shortDir(dir: string): string {
  const i = dir.lastIndexOf(".agentview");
  return i >= 0 ? dir.slice(i) : dir;
}

export function Onboarding(props: {
  boardDir: string;
  hooksReady: boolean;
  onClose: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="onboard-scrim" onClick={props.onDismiss}>
      <div className="onboard" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Pinboard guide">
        <h1>The Pinboard</h1>
        <p className="lede">
          A spatial canvas for your Claude Code agents. Watch them live, pin the work you care about,
          annotate it, and hand a selection back to an agent.
        </p>

        <ol className="steps">
          <li>
            <span className="step-n">1</span>
            <div>
              <b>Your agents live on the left rail.</b> Each card is a running agent — color shows status,
              with what it's doing right now, tokens and branch. Drag a card anywhere on the canvas.
            </div>
          </li>
          <li>
            <span className="step-n">2</span>
            <div>
              <b>Pin the work.</b> Hover a spawned agent card and hit <kbd>Pin diff</kbd> to freeze its current diff
              as a card that stays put — saved into <code>.agentview/board/</code> and committable to git. (External
              agents, which have no worktree, offer <kbd>Pin output</kbd> instead.)
            </div>
          </li>
          <li>
            <span className="step-n">3</span>
            <div>
              <b>Think on the canvas.</b> Add notes with <kbd>+ Note</kbd>, and connect two cards with an arrow:
              select two cards, then <kbd>Link</kbd>. Click an arrow's label to write your reasoning on it. Selecting
              one linked card selects the whole connected group.
            </div>
          </li>
          <li>
            <span className="step-n">4</span>
            <div>
              <b>Hand it back to an agent.</b> Select one or more cards, then press <kbd>Send</kbd> on any live
              agent card. The agent reads your selection and can post results straight back onto the board.
            </div>
          </li>
        </ol>

        <div className="legend">
          <span><i className="lg run" /> running</span>
          <span><i className="lg wait" /> waiting</span>
          <span><i className="lg done" /> done</span>
          <span><i className="lg err" /> error</span>
          <span className="legend-sep" />
          <span><i className="lg-box live" /> live agent (transient)</span>
          <span><i className="lg-box pinned" /> pinned card (saved)</span>
        </div>

        <p className="foot">
          {props.hooksReady
            ? "Live status is on. "
            : 'Tip: enable Claude Code hooks (run "Agent View: Configure Hooks") for real-time status. '}
          Agents read/write <code>{shortDir(props.boardDir)}</code>.
        </p>

        <button className="primary" onClick={props.onClose}>
          Got it — start pinning
        </button>
      </div>
    </div>
  );
}
