---
name: simulink-from-matlab
description: Build a clear, runnable Simulink model from a MATLAB simulation script and an assignment or technical document, preserving the object's variables, equations, disturbance paths, sensors, prediction logic, RUL calculation, and alarm outputs.
metadata:
  short-description: Convert MATLAB predictive-diagnosis models into Simulink structures
---

# MATLAB to Simulink model builder

Use this skill when a user provides MATLAB code and an assignment or technical document and asks for a Simulink structure representing the same industrial object, predictive-diagnosis algorithm, RCM logic, RUL calculation, sensors, disturbances, or alarms.

Preserve the source model's physical meaning and equations. Do not replace the requested object with a more familiar object. Do not claim that a generated model has run successfully unless MATLAB actually starts, builds, updates, and simulates it.

## Workflow

1. Read the assignment document and the complete MATLAB source.
2. Extract the object, measured variables and units, healthy and limit values, degradation law, noise and periodic terms, health-index formula, smoothing and regression windows, threshold, RUL definition, alarm rule, required toolboxes, and expected outputs.
3. Create a source-to-block mapping before writing code:
   - operating condition or reference;
   - physical plant or degradation model;
   - external disturbance;
   - measurement summation and sensor model;
   - sensor delay or sampling;
   - RCM/prediction algorithm;
   - Demux, scopes, displays, alarm and alarm start day.
4. Generate a new MATLAB builder script and a new `.slx` file. Do not overwrite the user's original model.
5. Run the builder, update/compile the model, simulate the requested time window, inspect signals and outputs, and report any unverified step honestly.

## Recommended structure

```text
Operating condition ──┐
                      ├─→ Plant/degradation model ─→ Sensors ─→ RCM predictor
Disturbance ──────────┘                                      ├─→ forecast
                                                           ├─→ RUL
                                                           └─→ alarm
```

Keep `Disturbance` separate when the source contains an additive term such as `k*t + A*sin(2*pi*t/T) + epsilon`. Put it before the plant if it changes physical load, and before the sensor if it represents measurement noise. Do not silently merge the two cases.

If the source has no controller, RCM output is diagnostic only and must not be fed directly back to the plant. Add feedback only when a controller or correction block is explicitly requested. Persistent state in a MATLAB Function block must not be placed in an algebraic loop; use a Unit Delay, Memory, or another discrete state where needed.

## Simulink construction rules

- Use `new_system`, `add_block`, `add_line`, `set_param`, and `save_system` in the builder.
- Build readable top-level subsystems with generous spacing. Keep the forward path horizontal; place measurement scopes below it and forecast/RUL/alarm displays to the right.
- Use MATLAB Function blocks for equations or algorithms that are inconvenient to express with primitive blocks.
- After creating a default Subsystem, remove its default `In1` to `Out1` line before replacing contents.
- Use `sfroot().find(...)` with parentheses, never `sfroot.find(...)`.
- Avoid `/` in block names because Simulink interprets it as a hierarchy separator. Put equations in annotations or subsystem descriptions instead.
- Delete an exact old connection before adding its replacement.
- Set `PortDimensions` explicitly for vector ports and keep dimensions consistent through Sum, Mux/Demux, Unit Delay, MATLAB Function, and Outport blocks.
- Use separate Demux blocks for measured variables and diagnostic results.

Typical vector outputs are `[V;T;I]`, `[vibration;insulation;temperature]`, or `[forecast_1;forecast_2;forecast_3;RUL;alarm;alarm_day]`. Document the output order in the MATLAB Function comment and in the model explanation.

## Predictive-analysis mapping

For a health-index model, preserve this order unless the source explicitly differs:

```text
measured variables
    → physical normalization by healthy/limit values
    → weighted health index
    → smoothing window
    → sliding regression window
    → threshold crossing time
    → RUL = predicted threshold time − current time
    → alarm logic
```

Use physical healthy and limit values when the source defines them; do not replace them with sample minimum and maximum. Account for trend direction: increasing vibration, temperature, or current usually reduces health, while decreasing insulation resistance reduces health.

Use fixed-size preallocated buffers in MATLAB Function blocks. Avoid indexing a window before it is full. Return fixed-size outputs on every execution path. During warm-up, use a documented sentinel such as `-1` for unavailable RUL or failure time rather than variable-size outputs.

For multi-parameter diagnosis, calculate the RUL for each valid trend and use the minimum valid RUL. If the trend is not moving toward a limit, return a documented unavailable value rather than inventing a failure date.

An auxiliary alarm for a noisy simulation may use:

```text
alarm_condition = predicted limit reached
                  OR predicted RUL <= warning window
alarm = 1 only after the condition persists for N samples
```

The warning window and confirmation count must come from the assignment or be clearly identified as an added Simulink modeling choice. Do not describe an added demonstration alarm as part of the original MATLAB algorithm.

## Verification and deliverables

Verify port widths, MATLAB Function parsing, algebraic-loop diagnostics, simulation stop time, and the expected threshold/failure day. Inspect at least measured signals, forecasts or HI, RUL, alarm, and alarm start day.

Deliver:

1. MATLAB builder script;
2. generated Simulink model, if MATLAB actually generated it;
3. short structure explanation covering object, signal flow, variables, thresholds, RUL meaning, and alarm trigger;
4. verification result and limitations such as synthetic data, simplified degradation, or unavailable MATLAB execution.

Use the source document's terminology. For a conveyor drive station with a wound-rotor induction motor, retain `АДФР`, bearing vibration `V`, stator winding temperature `T`, stator current `I`, health index `HI`, and remaining useful life `RUL` instead of reusing boiler or gearbox terminology.
