package main

// gofmt: dumps Go strconv.FormatFloat(x,'f',6,64) (== fmt "%f") for many values,
// so docs/js worker-fill.js goFmtF can be validated bit-exactly (string-equal).
// This is the exact quantization the primitive SVG applies to RotatedEllipse
// translate/rotate/scale and every shape's fill-opacity before Python re-parses.

import (
	"encoding/json"
	"math"
	"math/rand"
	"os"
	"strconv"
)

type gofmtDump struct {
	In  []string `json:"in"`  // float64 bits of input
	Out []string `json:"out"` // FormatFloat(x,'f',6,64)
}

func runGoFmt() {
	r := rand.New(rand.NewSource(20260724))
	d := gofmtDump{}
	push := func(x float64) {
		d.In = append(d.In, strconv.FormatUint(math.Float64bits(x), 10))
		d.Out = append(d.Out, strconv.FormatFloat(x, 'f', 6, 64))
	}
	// fill-opacity: A/255 for A in 0..255 (exact set the pipeline uses)
	for a := 0; a <= 255; a++ {
		push(float64(a) / 255.0)
	}
	// RotatedEllipse geometry ranges: X,Y in [0,W-1], Rx,Ry in [1,W-1],
	// Angle unbounded (can drift negative / large). Stress the rounding.
	for i := 0; i < 30000; i++ {
		switch i % 5 {
		case 0:
			push(r.Float64() * 2048)
		case 1:
			push(r.Float64()*64 + 1)
		case 2:
			push(r.Float64()*2000 - 1000) // angles, signed
		case 3:
			// values engineered near a 6th-decimal tie
			push(math.Trunc(r.Float64()*1e6*1000) / 1e9)
		default:
			push(r.NormFloat64() * 100)
		}
	}
	f, err := os.Create("gofmt_golden.json")
	if err != nil {
		panic(err)
	}
	defer f.Close()
	if err := json.NewEncoder(f).Encode(d); err != nil {
		panic(err)
	}
}
