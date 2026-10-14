/** Synthetic declarative game; never used as production evidence. */
export function createFixtureGame() {
  let episodeId = "";
  let revision = 0;
  let events = [];

  return {
    reset({ seed, scenarioId }) {
      episodeId = `fixture-${String(seed)}-${scenarioId}`;
      revision = 0;
      events = [];
      return {
        episodeId,
        revision,
        rngProvenance: {
          algorithm: "pcg",
          version: "fixture-rng-v1",
          initialStateHash: "a".repeat(64),
          reproducible: true
        }
      };
    },
    observe() {
      return {
        episodeId,
        revision,
        observation: { room: "start" },
        turnContext: null,
        frame: null
      };
    },
    legalActions() {
      return {
        episodeId,
        revision,
        actions: [
          { actionId: "advance", description: "Advance" },
          { actionId: "wait", description: "Wait" }
        ]
      };
    },
    step({ actionId }) {
      revision += 1;
      const event = {
        eventId: "evt-" + String(revision),
        type: "step-applied",
        phaseId: "race",
        step: revision - 1,
        revision,
        actor: "player",
        fields: { actionId }
      };
      events = [event];
      return {
        episodeId,
        revision,
        acceptedActionId: actionId,
        eventIds: [event.eventId],
        terminal: false
      };
    },
    captureEvents({ startStep, endStep }) {
      return {
        episodeId,
        revision,
        events: events.filter(
          (event) => event.step >= startStep && event.step <= endStep
        ),
        omittedCount: 0
      };
    },
    outcome() {
      return {
        episodeId,
        revision,
        state: "terminal",
        outcome: "completed",
        metrics: {},
        evaluations: [
          {
            metricId: "legal-action-rejection",
            metricVersion: 1,
            phaseId: "tutorial",
            evaluatorRef: "fixture/legal-action-rejection-v1",
            evaluatorHash: "1".repeat(64),
            numerator: 0,
            denominator: 0,
            opportunityCount: 0,
            missing: 0,
            independentUnits: 0,
            unit: "proportion",
            missingReasons: ["unobserved"]
          }
        ],
        missingReasons: []
      };
    }
  };
}
