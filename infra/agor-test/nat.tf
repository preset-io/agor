variable "nat_egress_enabled" {
  description = "Switch app subnet egress after the NAT instance has booted; false restores direct IGW routing."
  type        = bool
  default     = true
}
data "aws_ssm_parameter" "nat_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}
resource "aws_security_group" "nat" {
  name_prefix = "agor-nat-"
  vpc_id      = aws_vpc.test.id
  ingress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = [aws_subnet.test[2].cidr_block]
  }
  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_iam_role" "nat" {
  name_prefix        = "agor-nat-"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy_attachment" "nat_ssm" {
  role       = aws_iam_role.nat.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}
resource "aws_iam_instance_profile" "nat" { role = aws_iam_role.nat.name }
resource "aws_instance" "nat" {
  ami                         = data.aws_ssm_parameter.nat_ami.value
  instance_type               = "t4g.nano"
  subnet_id                   = aws_subnet.test[0].id
  associate_public_ip_address = true
  source_dest_check           = false
  vpc_security_group_ids      = [aws_security_group.nat.id]
  iam_instance_profile        = aws_iam_instance_profile.nat.name
  user_data                   = templatefile("${path.module}/nat-bootstrap.sh.tftpl", { source_cidr = aws_subnet.test[2].cidr_block })
  user_data_replace_on_change = true
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  root_block_device {
    volume_type = "gp3"
    volume_size = 8
    encrypted   = true
  }
  credit_specification { cpu_credits = "standard" }
  depends_on = [aws_iam_role_policy_attachment.nat_ssm, aws_internet_gateway.test]
  tags       = { Name = "agor-nat" }
}
resource "aws_eip" "nat" {
  domain   = "vpc"
  instance = aws_instance.nat.id
  tags     = { Name = "agor-nat" }
}
resource "aws_route_table" "app_egress" {
  vpc_id = aws_vpc.test.id
  route {
    cidr_block           = "0.0.0.0/0"
    network_interface_id = aws_instance.nat.primary_network_interface_id
  }
  tags = { Name = "agor-app-nat-egress" }
}
output "nat_instance_id" { value = aws_instance.nat.id }
output "nat_public_ip" { value = aws_eip.nat.public_ip }
