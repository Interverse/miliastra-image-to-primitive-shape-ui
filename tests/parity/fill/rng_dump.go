package main

// rng_dump: dumps long deterministic sequences of every math/rand method used
// by the fogleman/primitive fill algorithm, for several seeds, so the JS port
// (docs/js/gorand.js) can be validated bit-exactly. Float64/NormFloat64 are
// emitted as their raw float64 bits (math.Float64bits) so comparison is exact.
//
// Usage: go run . rng > rng_golden.json

import (
	"encoding/json"
	"math"
	"math/rand"
	"strconv"
	"os"
)

type rngDump struct {
	Seed       int64    `json:"seed"`
	Int63      []string `json:"int63"` // int64 as decimal string (exact)
	Int31      []int32  `json:"int31"`
	Uint32     []uint32 `json:"uint32"`
	Intn21     []int    `json:"intn21"`  // Intn(21) — non power of two
	Intn3      []int    `json:"intn3"`   // Intn(3)
	Intn31     []int    `json:"intn31"`  // Intn(31)
	Intn32     []int    `json:"intn32"`  // Intn(32) — power of two fast path
	Intn360    []int    `json:"intn360"` // Intn(360)
	Intn8      []int    `json:"intn8"`   // Intn(8)
	IntnW      []int    `json:"intnW"`   // Intn(160), Intn(120) mixed
	Float64bit []string `json:"float64bits"` // uint64 bits as decimal string
	NormBits   []string `json:"normbits"`    // uint64 bits as decimal string
}

func runRNG() {
	seeds := []int64{1, 42, 1337, 9999999}
	n := 1000
	nBig := 20000
	out := []rngDump{}
	for _, seed := range seeds {
		d := rngDump{Seed: seed}

		r := rand.New(rand.NewSource(seed))
		for i := 0; i < n; i++ {
			d.Int63 = append(d.Int63, strconv.FormatInt(r.Int63(), 10))
		}
		r = rand.New(rand.NewSource(seed))
		for i := 0; i < n; i++ {
			d.Int31 = append(d.Int31, r.Int31())
		}
		r = rand.New(rand.NewSource(seed))
		for i := 0; i < n; i++ {
			d.Uint32 = append(d.Uint32, r.Uint32())
		}
		r = rand.New(rand.NewSource(seed))
		for i := 0; i < n; i++ {
			d.Intn21 = append(d.Intn21, r.Intn(21))
		}
		r = rand.New(rand.NewSource(seed))
		for i := 0; i < n; i++ {
			d.Intn3 = append(d.Intn3, r.Intn(3))
		}
		r = rand.New(rand.NewSource(seed))
		for i := 0; i < n; i++ {
			d.Intn31 = append(d.Intn31, r.Intn(31))
		}
		r = rand.New(rand.NewSource(seed))
		for i := 0; i < n; i++ {
			d.Intn32 = append(d.Intn32, r.Intn(32))
		}
		r = rand.New(rand.NewSource(seed))
		for i := 0; i < n; i++ {
			d.Intn360 = append(d.Intn360, r.Intn(360))
		}
		r = rand.New(rand.NewSource(seed))
		for i := 0; i < n; i++ {
			d.Intn8 = append(d.Intn8, r.Intn(8))
		}
		r = rand.New(rand.NewSource(seed))
		for i := 0; i < n; i++ {
			if i%2 == 0 {
				d.IntnW = append(d.IntnW, r.Intn(160))
			} else {
				d.IntnW = append(d.IntnW, r.Intn(120))
			}
		}
		// Float64 and NormFloat64: long sequences, compared as bits.
		r = rand.New(rand.NewSource(seed))
		for i := 0; i < nBig; i++ {
			d.Float64bit = append(d.Float64bit, strconv.FormatUint(math.Float64bits(r.Float64()), 10))
		}
		r = rand.New(rand.NewSource(seed))
		for i := 0; i < nBig; i++ {
			d.NormBits = append(d.NormBits, strconv.FormatUint(math.Float64bits(r.NormFloat64()), 10))
		}
		out = append(out, d)
	}
	f, err := os.Create("rng_golden.json")
	if err != nil {
		panic(err)
	}
	defer f.Close()
	if err := json.NewEncoder(f).Encode(out); err != nil {
		panic(err)
	}
}
