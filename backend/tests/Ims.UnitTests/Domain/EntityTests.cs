using Ims.Domain.Common;

namespace Ims.UnitTests.Domain;

public sealed class EntityTests
{
    private sealed class TestEntity : Entity;

    [Fact]
    public void New_entity_gets_a_time_ordered_version_7_id()
    {
        var entity = new TestEntity();

        Assert.NotEqual(Guid.Empty, entity.Id);
        Assert.Equal(7, entity.Id.Version);
    }

    [Fact]
    public void Each_entity_gets_a_distinct_id()
    {
        Assert.NotEqual(new TestEntity().Id, new TestEntity().Id);
    }
}
