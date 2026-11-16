// evaluate-corpus computes offline metrics from an approved, de-identified adjudication corpus.
// It does not load or call the live correlator and cannot change runtime policy.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/CyberStill-GmbH/qapaq-secops/services/qapaq-correlator/internal/evaluation"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("evaluate-corpus", flag.ContinueOnError)
	flags.SetOutput(stderr)
	inputPath := flags.String("input", "", "path to the approved de-identified corpus JSON")
	outputPath := flags.String("output", "-", "report path, or - for stdout")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *inputPath == "" || flags.NArg() != 0 {
		fmt.Fprintln(stderr, "usage: evaluate-corpus -input corpus.json [-output report.json]")
		return 2
	}
	input, err := os.Open(*inputPath)
	if err != nil {
		fmt.Fprintf(stderr, "open corpus: %v\n", err)
		return 2
	}
	defer input.Close()
	data, err := io.ReadAll(io.LimitReader(input, evaluation.MaxInputBytes+1))
	if err != nil {
		fmt.Fprintf(stderr, "read corpus: %v\n", err)
		return 2
	}
	if int64(len(data)) > evaluation.MaxInputBytes {
		fmt.Fprintf(stderr, "corpus exceeds %d bytes\n", evaluation.MaxInputBytes)
		return 2
	}
	corpus, err := evaluation.Decode(bytes.NewReader(data))
	if err != nil {
		fmt.Fprintf(stderr, "%v\n", err)
		return 2
	}
	report, err := evaluation.Evaluate(corpus)
	if err != nil {
		fmt.Fprintf(stderr, "invalid corpus: %v\n", err)
		return 2
	}
	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		fmt.Fprintf(stderr, "encode report: %v\n", err)
		return 2
	}
	encoded = append(encoded, '\n')
	if *outputPath == "-" {
		if _, err := stdout.Write(encoded); err != nil {
			fmt.Fprintf(stderr, "write report: %v\n", err)
			return 2
		}
	} else if err := writeReport(*outputPath, encoded); err != nil {
		fmt.Fprintf(stderr, "write report: %v\n", err)
		return 2
	}
	if !report.GuardrailsPassed {
		fmt.Fprintln(stderr, "guardrail violations found; metrics were written, but this candidate fails preservation checks")
		return 3
	}
	if !report.SufficientEvidence {
		fmt.Fprintln(stderr, "insufficient evidence; metrics were written, but this corpus cannot pass the quality gate")
		return 4
	}
	return 0
}

func writeReport(path string, content []byte) error {
	if path == "" {
		return errors.New("output path cannot be empty")
	}
	return os.WriteFile(path, content, 0o600)
}
