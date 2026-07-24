package main

// gomath: dumps Go math.{Sin,Cos,Acos,Atan2,Pow} results as float64 bits for
// many inputs, so docs/js/gomath.js can be validated bit-exactly.
// Writes gomath_golden.json directly (no BOM).

import (
	"encoding/json"
	"math"
	"math/rand"
	"os"
	"strconv"
)

type mathDump struct {
	SinIn   []string `json:"sin_in"`   // float64 bits of input
	SinOut  []string `json:"sin_out"`  // float64 bits of Sin(input)
	CosOut  []string `json:"cos_out"`  // Cos(same inputs)
	AcosIn  []string `json:"acos_in"`
	AcosOut []string `json:"acos_out"`
	At2Y    []string `json:"at2_y"`
	At2X    []string `json:"at2_x"`
	At2Out  []string `json:"at2_out"`
	PowX    []string `json:"pow_x"`
	PowY    []string `json:"pow_y"`
	PowOut  []string `json:"pow_out"`
}

func fb(f float64) string { return strconv.FormatUint(math.Float64bits(f), 10) }

func runGoMath() {
	r := rand.New(rand.NewSource(777))
	d := mathDump{}
	N := 25000

	// Sin/Cos: angles across the pipeline's range plus stress values below
	// reduceThreshold (1<<29). Include the exact ellipse angles.
	for i := 0; i < N; i++ {
		var x float64
		switch i % 4 {
		case 0:
			x = (r.Float64()*8 - 4) * math.Pi // [-4π, 4π]
		case 1:
			x = r.Float64()*720 - 360 // degrees-as-radians range
		case 2:
			x = r.Float64()*2e6 - 1e6 // large but < reduceThreshold
		default:
			// exact ellipse construction angles
			k := i % 16
			p1 := float64(k) / 16
			p2 := float64(k+1) / 16
			a1 := p1 * 2 * math.Pi
			a2 := p2 * 2 * math.Pi
			if i%2 == 0 {
				x = a1 + (a2-a1)/2
			} else {
				x = r.Float64() * 360 * math.Pi / 180
			}
		}
		d.SinIn = append(d.SinIn, fb(x))
		d.SinOut = append(d.SinOut, fb(math.Sin(x)))
		d.CosOut = append(d.CosOut, fb(math.Cos(x)))
	}

	// Acos: inputs in [-1, 1] (Triangle.Valid dot products).
	for i := 0; i < N; i++ {
		x := r.Float64()*2 - 1
		d.AcosIn = append(d.AcosIn, fb(x))
		d.AcosOut = append(d.AcosOut, fb(math.Acos(x)))
	}

	// Atan2: general pairs (validation of the port; Python-side uses its own libm).
	for i := 0; i < N; i++ {
		y := r.Float64()*2000 - 1000
		x := r.Float64()*2000 - 1000
		d.At2Y = append(d.At2Y, fb(y))
		d.At2X = append(d.At2X, fb(x))
		d.At2Out = append(d.At2Out, fb(math.Atan2(y, x)))
	}

	// Pow: the ONLY exponent the fill pipeline uses is 2 (differencePartial's
	// math.Pow(score*255, 2)). Go's pow(x,2) is the correctly-rounded x², which
	// gomath.pow returns via its fast x*x path — validated bit-exact here.
	// (gomath.pow's general-exponent branch relies on V8 Exp/Log and is NOT
	// bit-exact to Go; it is never exercised by this pipeline.)
	for i := 0; i < N; i++ {
		var x float64
		switch i % 3 {
		case 0:
			x = r.Float64() * 510 // score*255 range
		case 1:
			x = r.Float64() * 1e6
		default:
			x = r.Float64()
		}
		d.PowX = append(d.PowX, fb(x))
		d.PowY = append(d.PowY, fb(2))
		d.PowOut = append(d.PowOut, fb(math.Pow(x, 2)))
	}

	f, err := os.Create("gomath_golden.json")
	if err != nil {
		panic(err)
	}
	defer f.Close()
	if err := json.NewEncoder(f).Encode(d); err != nil {
		panic(err)
	}
}
