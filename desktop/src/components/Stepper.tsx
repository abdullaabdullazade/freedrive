interface Step {
  number: number;
  label: string;
  sublabel?: string;
}

interface StepperProps {
  steps: Step[];
  current: number;
}

export function Stepper({ steps, current }: StepperProps) {
  return (
    <div className="stepper">
      {steps.map((step) => {
        const done = step.number < current;
        const active = step.number === current;
        return (
          <div
            key={step.number}
            className={`stepper-item${active ? " active" : ""}${done ? " done" : ""}`}
          >
            <div className="stepper-circle">
              {done ? "✓" : step.number}
            </div>
            <div>
              <div className="stepper-label">{step.label}</div>
              {step.sublabel && (
                <div className="stepper-sublabel">{step.sublabel}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
