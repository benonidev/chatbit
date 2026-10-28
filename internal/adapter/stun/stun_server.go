package main

import (
	"encoding/binary"
	"fmt"
	"log"
	"net"
)

const (
	stunBindingRequest  = 0x0001
	stunBindingResponse = 0x0101
	stunMagicCookie     = 0x2112A442
	attrXorMapped       = 0x0020
)

func main() {
	addr := net.UDPAddr{Port: 3478, IP: net.ParseIP("0.0.0.0")}
	conn, err := net.ListenUDP("udp", &addr)
	if err != nil {
		log.Fatal(err)
	}
	defer conn.Close()

	log.Println("STUN server running on UDP :3478")

	buf := make([]byte, 1024)

	for {
		n, clientAddr, err := conn.ReadFromUDP(buf)
		if err != nil {
			continue
		}

		if n < 20 {
			continue
		}

		go handleStunRequest(conn, clientAddr, buf[:n])
	}
}

func handleStunRequest(conn *net.UDPConn, client *net.UDPAddr, msg []byte) {
	msgType := binary.BigEndian.Uint16(msg[0:2])
	msgLen := binary.BigEndian.Uint16(msg[2:4])
	magic := binary.BigEndian.Uint32(msg[4:8])

	if msgType != stunBindingRequest || magic != stunMagicCookie || len(msg) < int(20+msgLen) {
		return // ignore non-binding or invalid messages
	}

	// STUN response
	resp := make([]byte, 20) // header only first
	binary.BigEndian.PutUint16(resp[0:2], stunBindingResponse)
	// message length set later after attributes
	binary.BigEndian.PutUint32(resp[4:8], stunMagicCookie)

	// Copy transaction ID
	copy(resp[8:20], msg[8:20])

	// Build XOR-MAPPED-ADDRESS attribute
	attr := buildXorMappedAddress(client, msg[4:20]) // magic + txID

	resp = append(resp, attr...)

	// Now set message length
	binary.BigEndian.PutUint16(resp[2:4], uint16(len(resp)-20))

	fmt.Printf("Received STUN request from %s\n", client.String())
	fmt.Printf("Received STUN request from %s\n", resp)

	_, _ = conn.WriteToUDP(resp, client)
}

func buildXorMappedAddress(addr *net.UDPAddr, cookieAndTxID []byte) []byte {
	ip4 := addr.IP.To4()
	if ip4 != nil {
		attr := make([]byte, 4+8) // header + 8 bytes for IPv4 family
		// Attribute header
		binary.BigEndian.PutUint16(attr[0:2], attrXorMapped)
		binary.BigEndian.PutUint16(attr[2:4], 8) // length for IPv4
		// Family (0x01 = IPv4)
		attr[4] = 0
		attr[5] = 0x01
		// XOR port: XOR with top 16 bits of magic cookie
		xorPort := uint16(addr.Port) ^ binary.BigEndian.Uint16(cookieAndTxID[:2])
		binary.BigEndian.PutUint16(attr[6:8], xorPort)
		// XOR IPv4 address: XOR with magic cookie
		for i := 0; i < 4; i++ {
			attr[8+i] = ip4[i] ^ cookieAndTxID[i]
		}
		return attr
	}

	// IPv6 Logic
	ip6 := addr.IP.To16()
	if ip6 == nil {
		return nil // Invalid IP
	}

	attr := make([]byte, 4+20) // header + 20 bytes for IPv6 family
	// Attribute header
	binary.BigEndian.PutUint16(attr[0:2], attrXorMapped)
	binary.BigEndian.PutUint16(attr[2:4], 20) // length for IPv6
	// Family (0x02 = IPv6)
	attr[4] = 0
	attr[5] = 0x02
	// XOR port
	xorPort := uint16(addr.Port) ^ binary.BigEndian.Uint16(cookieAndTxID[:2])
	binary.BigEndian.PutUint16(attr[6:8], xorPort)
	// XOR IPv6 address: XOR with Magic Cookie + Transaction ID (16 bytes)
	for i := 0; i < 16; i++ {
		attr[8+i] = ip6[i] ^ cookieAndTxID[i]
	}
	return attr
}
