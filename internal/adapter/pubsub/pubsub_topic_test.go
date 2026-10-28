package pubsub_test

import (
	"chatbit/internal/adapter/pubsub"
	"errors"
	"testing"
	"time"

	uuid "github.com/google/uuid"
	"github.com/stretchr/testify/suite"
)

type PubSubTopicTestSuite struct {
	suite.Suite

	sut *pubsub.AdapterTopic[uuid.UUID, uuid.UUID]
}

func TestPubSubTopicSuite(t *testing.T) {
	suite.Run(t, new(PubSubTopicTestSuite))
}

func (s *PubSubTopicTestSuite) SetupTest() {
	s.sut = pubsub.NewAdapterTopic[uuid.UUID, uuid.UUID]()
}

func (s *PubSubTopicTestSuite) TearDownTest() {}

func (s *PubSubTopicTestSuite) TestPubSubTopic() {
	// var
	var someOutput uuid.UUID
	someInput, _ := uuid.NewUUID()
	someTopic, _ := uuid.NewUUID()

	wait := make(chan bool, 1)

	// act
	_, err := s.sut.Subscribe(someTopic, func(obj uuid.UUID) {
		someOutput = obj

		wait <- true
	})
	s.NoError(err)

	s.NoError(s.sut.Publish(someTopic, someInput))

	<-wait

	s.Equal(someInput, someOutput)
}

func (s *PubSubTopicTestSuite) TestPubSubTopicUnsubscribe() {
	// var
	var someOutput uuid.UUID
	someInput, _ := uuid.NewUUID()
	someTopic, _ := uuid.NewUUID()

	wait := make(chan bool, 1)

	// act
	subID, err := s.sut.Subscribe(someTopic, func(obj uuid.UUID) {
		someOutput = obj

		wait <- true
	})
	s.NoError(err)

	s.NoError(s.sut.Publish(someTopic, someInput))

	select {
	case <-wait:
		s.Equal(someInput, someOutput)
	case <-time.After(100 * time.Millisecond):
		s.Require().NoError(errors.New("no subscribe trigger received"))
	}

	s.NoError(s.sut.UnsubscribeFromTopic(someTopic, subID))

	select {
	case <-wait:
		s.Require().NoError(errors.New("still subscribe trigger received"))
	case <-time.After(100 * time.Millisecond):
	}
}

func (s *PubSubTopicTestSuite) TestPubSubTopicDifferentTopics() {
	// var
	var someOutput uuid.UUID
	someInput, _ := uuid.NewUUID()
	someTopic1, _ := uuid.NewUUID()
	someTopic2, _ := uuid.NewUUID()

	wait := make(chan bool, 1)

	// act
	_, err := s.sut.Subscribe(someTopic1, func(obj uuid.UUID) {
		someOutput = obj

		wait <- true
	})
	s.NoError(err)

	_, err = s.sut.Subscribe(someTopic2, func(obj uuid.UUID) {
		s.Require().NoError(errors.New("wrong topic"))
	})
	s.NoError(err)

	s.NoError(s.sut.Publish(someTopic1, someInput))

	<-wait

	s.Equal(someInput, someOutput)
}

func (s *PubSubTopicTestSuite) TestPubSubTopicDifferentTopicsSameSub() {
	// var
	var someOutput uuid.UUID
	someInput1, _ := uuid.NewUUID()
	someInput2, _ := uuid.NewUUID()
	someTopic1, _ := uuid.NewUUID()
	someTopic2, _ := uuid.NewUUID()

	wait := make(chan bool, 1)

	// act
	subID, err := s.sut.Subscribe(someTopic1, func(obj uuid.UUID) {
		someOutput = obj

		wait <- true
	})
	s.NoError(err)

	err = s.sut.AddSubscriberToTopic(someTopic2, subID)
	s.NoError(err)

	s.NoError(s.sut.Publish(someTopic1, someInput1))

	<-wait
	s.Equal(someInput1, someOutput)

	s.NoError(s.sut.Publish(someTopic2, someInput2))
	<-wait
	s.Equal(someInput2, someOutput)

}

func (s *PubSubTopicTestSuite) TestPubSubTopicAfterClose() {
	// var
	var someOutput uuid.UUID
	someInput, _ := uuid.NewUUID()
	someTopic, _ := uuid.NewUUID()

	wait := make(chan bool, 1)

	// act
	_, err := s.sut.Subscribe(someTopic, func(obj uuid.UUID) {
		someOutput = obj

		wait <- true
	})
	s.NoError(err)

	s.NoError(s.sut.Publish(someTopic, someInput))

	select {
	case <-wait:
		s.Equal(someInput, someOutput)
	case <-time.After(100 * time.Millisecond):
		s.Require().NoError(errors.New("no subscribe trigger received"))
	}

	s.NoError(s.sut.Close())

	s.ErrorIs(s.sut.Publish(someTopic, someInput), pubsub.ErrAlreadyClosed)

	select {
	case <-wait:
		s.Require().NoError(errors.New("still subscribe trigger received"))
	case <-time.After(100 * time.Millisecond):
	}
}

func (s *PubSubTopicTestSuite) TestPubSubTopicPublishToNotExistingTopic() {
	// var
	someInput, _ := uuid.NewUUID()
	someTopic, _ := uuid.NewUUID()

	// act
	s.NoError(s.sut.Publish(someTopic, someInput))
}

func (s *PubSubTopicTestSuite) TestPubSubTopicMultiSubs() {
	// var
	var someOutput1, someOutput2 uuid.UUID
	someInput, _ := uuid.NewUUID()
	someTopic, _ := uuid.NewUUID()

	wait1 := make(chan bool, 1)
	wait2 := make(chan bool, 1)

	// act
	_, err := s.sut.Subscribe(someTopic, func(obj uuid.UUID) {
		someOutput1 = obj

		wait1 <- true
	})
	s.NoError(err)

	_, err = s.sut.Subscribe(someTopic, func(obj uuid.UUID) {
		someOutput2 = obj

		wait2 <- true
	})
	s.NoError(err)

	s.NoError(s.sut.Publish(someTopic, someInput))

	<-wait1
	<-wait2

	s.Equal(someInput, someOutput1)

	s.Equal(someInput, someOutput2)
}
