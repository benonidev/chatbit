package pubsub_test

import (
	"chatbit/internal/adapter/pubsub"
	"testing"
	"time"

	"errors"

	"github.com/golang/mock/gomock"
	"github.com/google/uuid"
	"github.com/stretchr/testify/suite"
)

type PubSubTestSuite struct {
	suite.Suite
	ctrl *gomock.Controller

	sut *pubsub.Adapter[uuid.UUID, uuid.UUID]
}

func TestPubSubSuite(t *testing.T) {
	suite.Run(t, new(PubSubTestSuite))
}

func (s *PubSubTestSuite) SetupTest() {
	s.ctrl = gomock.NewController(s.T())

	s.sut = pubsub.NewAdapter[uuid.UUID, uuid.UUID]()
}

func (s *PubSubTestSuite) TearDownTest() {
	s.ctrl.Finish()
}

func (s *PubSubTestSuite) Test_PubSub() {
	// var
	var someOutput uuid.UUID
	someInput, _ := uuid.NewUUID()

	wait := make(chan bool, 1)

	// act
	_, err := s.sut.Subscribe(func(obj uuid.UUID) {
		someOutput = obj

		wait <- true
	})
	s.NoError(err)

	s.NoError(s.sut.Publish(someInput))

	<-wait

	s.Equal(someInput, someOutput)
}

func (s *PubSubTestSuite) Test_PubSub_Unsubscribe() {
	// var
	var someOutput uuid.UUID
	someInput, _ := uuid.NewUUID()

	wait := make(chan bool, 1)

	// act
	subID, err := s.sut.Subscribe(func(obj uuid.UUID) {
		someOutput = obj

		wait <- true
	})
	s.NoError(err)

	s.NoError(s.sut.Publish(someInput))

	select {
	case <-wait:
		s.Equal(someInput, someOutput)
	case <-time.After(100 * time.Millisecond):
		s.Require().NoError(errors.New("no subscribe trigger received"))
	}

	s.NoError(s.sut.Unsubscribe(subID))

	select {
	case <-wait:
		s.Require().NoError(errors.New("still subscribe trigger received"))
	case <-time.After(100 * time.Millisecond):
	}
}

func (s *PubSubTestSuite) Test_PubSub_toOneSubscriber() {
	// var
	var someOutput uuid.UUID
	someInput, _ := uuid.NewUUID()

	wait := make(chan bool, 1)

	// act
	_, err := s.sut.Subscribe(func(obj uuid.UUID) {
		s.Require().NoError(errors.New("wrong subscriber"))
	})
	s.NoError(err)

	subID, err := s.sut.Subscribe(func(obj uuid.UUID) {
		someOutput = obj

		wait <- true
	})
	s.NoError(err)

	s.NoError(s.sut.PublishTo(subID, someInput))

	<-wait

	s.Equal(someInput, someOutput)
}

func (s *PubSubTestSuite) Test_PubSub_afterClose() {
	// var
	var someOutput uuid.UUID
	someInput, _ := uuid.NewUUID()

	wait := make(chan bool, 1)

	// act
	subID, err := s.sut.Subscribe(func(obj uuid.UUID) {
		someOutput = obj

		wait <- true
	})
	s.NoError(err)

	s.NoError(s.sut.Publish(someInput))

	select {
	case <-wait:
		s.Equal(someInput, someOutput)
	case <-time.After(100 * time.Millisecond):
		s.Require().NoError(errors.New("no subscribe trigger received"))
	}

	s.NoError(s.sut.Close())

	s.ErrorIs(s.sut.Publish(someInput), pubsub.ErrAlreadyClosed)

	select {
	case <-wait:
		s.Require().NoError(errors.New("still subscribe trigger received"))
	case <-time.After(100 * time.Millisecond):
	}

	s.ErrorIs(s.sut.PublishTo(subID, someInput), pubsub.ErrAlreadyClosed)

	select {
	case <-wait:
		s.Require().NoError(errors.New("still subscribe trigger received"))
	case <-time.After(100 * time.Millisecond):
	}
}
